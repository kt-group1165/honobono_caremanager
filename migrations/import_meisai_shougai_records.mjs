// ============================================================================
// ほのぼの「稼働データ」MEISAI CSV → kaigo_visit_schedule 障害実績取込
//   取込元: apps/kaigo-app/サービス実績データ/大網/介護/202606/MEISAI_*.csv
//   取込先: kaigo_visit_schedule (status='completed' = 実績)。障害は system 列でなく
//           service_type(=障害マスタの service_name 完全一致) で shogai-seikyu/aggregate.ts
//           が拾う (kaigo_visit_schedule に system 列は無い)。
//
//   対象 = 内部コード 021001(身体介護 自立) / 021002(家事援助 自立) の 障害福祉サービス行。
//   これを 障害 居宅介護 の正式サービスコード (111xxxx = 身体介護 / 111 2xxx = 家事援助) に
//   算定時間 × 時間帯 で変換して取り込む。
//
//   使い方:
//     node migrations/import_meisai_shougai_records.mjs            # DRY RUN (既定・書込なし)
//     node migrations/import_meisai_shougai_records.mjs --execute  # 本番 INSERT
//
//   ─ 時間区分の境界 (app_settings.shogai_time_bracket_mode, 既定 honobono) ─
//     honobono (ほのぼの互換): 境界値は下位区分に属する = 告示ブラケットを (分-1) で引く。
//       例) 身体 60分 → 「30分〜1時間」(1111021) / 90分 → 「1時間〜1時間30分」(1111031)
//     kokuji  (告示準拠):      境界値は上位区分 = 告示ブラケットを (分) で引く。
//       例) 身体 60分 → 「1時間〜1時間30分」(1111031)
//     ほのぼの実績と請求額を一致させるため既定 honobono。(src/lib/shogai-time-bracket.ts /
//     src/components/services/service-selector.tsx の parseServiceDurationMinutes と同一規約)
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const TARGET_MONTH = "2026-06";
const MONTH_FIRST = "2026-06-01";
const AREA_DIR = process.env.AREA_DIR || "大網/介護"; // 大網 稼働データは 介護 配下に同居
const OFFICE_ID = process.env.OFFICE_ID || "269d77bc-5b61-4114-a2ea-e8dc2f220823"; // リンクスヘルパーステーション大網白里
const OFFICE_BN = process.env.OFFICE_BN || "1275800892";
const TENANT_ID = "kt-group";
const MAP_TAG = process.env.MAP_TAG || "大網"; // _meisai_num_to_client_大網.json
const CSV_DIR = fileURLToPath(new URL(`../サービス実績データ/${AREA_DIR}/202606/`, import.meta.url));

// ---- env ----
function loadEnv() {
  const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---- 正規化 ----
const normBase = (s) => (s || "").normalize("NFKC").replace(/[\s　]/g, "");
const normStaff = (s) => normBase(s).replace(/様$/, "");
// 利用者名の照合用。稼働データは氏名の末尾に制度の目印を付けることがある
//   (大網 「神田　祐介（支）」= 支援 の意。clients 側は「神田 祐介」)。
//   末尾の (…) を落として突合する。中黒や敬称の揺れも吸収。
const normClientName = (s) => normBase(s).replace(/[（(][^）)]*[）)]\s*$/, "").replace(/様$/, "");

// ---- SJIS CSV ----
const sjis = new TextDecoder("shift_jis");
function readCsv(file) {
  const text = sjis.decode(readFileSync(file));
  const lines = text.split(/\r?\n/).filter((l) => l !== "");
  const idx = {};
  lines[0].split(",").forEach((h, i) => (idx[h.trim()] = i));
  return { idx, rows: lines.slice(1).map((l) => l.split(",")) };
}

// ---- "HHH:MM" → 分 ----
function santeiToMinutes(s) {
  const m = /^(\d+):(\d{2})$/.exec((s || "").trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// ---- 算定開始時刻 "HH:MM" → 時間帯コード桁 (1 日中 / 2 早間 / 3 夜間 / 4 深間) ----
//   境界は service-selector.classifyStartTimeZone と同一 (深夜22-6 / 早朝6-8 / 日中8-18 / 夜間18-22)
function zoneDigit(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec((hhmm || "").trim());
  if (!m) return { digit: "1", zone: "日中(既定)" };
  const mins = Number(m[1]) * 60 + Number(m[2]);
  if (mins < 6 * 60 || mins >= 22 * 60) return { digit: "4", zone: "深夜" };
  if (mins < 8 * 60) return { digit: "2", zone: "早朝" };
  if (mins < 18 * 60) return { digit: "1", zone: "日中" };
  return { digit: "3", zone: "夜間" };
}

// ---- 時間区分モード ----
async function getTimeBracketMode() {
  const { data, error } = await sb
    .from("app_settings").select("value").eq("key", "shogai_time_bracket_mode").maybeSingle();
  if (error) { console.warn("time_bracket_mode 取得失敗、honobono で続行:", error.message); return "honobono"; }
  const v = data?.value;
  return v === "kokuji" ? "kokuji" : "honobono";
}

// ---- 021 → 障害「公式6桁」コード変換 (2026-07-17 rewrite / 合成・2人 対応) ----
//   旧実装は非公式7桁(1111021等)を出していた。マスタには r8_06 の公式6桁
//   (身体日1.0=111115 / 家事日1.0=116115 / 家事日0.75=117651 …) があり、
//   ほのぼの伝送KJの31コード中30が単位まで一致 = これが正解。
//   マスタの service_name をパースして single/composite/single2/composite2 の lookup を作り
//   (loadCodeMaps)、算定時間を量子化(身体=0.5h/30分、家事=0.25h/15分、honobono境界=下位)して引く。
//   時間帯またぎ = 合成コード (身体早0.5・日1.5 等)、同時2人派遣 = ・2人 コードに対応。
const ZONE_KANJI = { "日中": "日", "早朝": "早", "夜間": "夜", "深夜": "深" };

// 算定時間(分) → 官報時間(数値, 身体=0.5刻み/家事=0.25刻み)
//   honobono: 境界は下位区分に含める (60分→1.0=「1時間まで」)。ceil で表現。
//   kokuji  : 境界は上位区分 (60分→1.5)。ちょうど境界のとき +1 単位。
function quantizeHours(minutes, stepMin, mode) {
  let units;
  if (mode === "kokuji") units = (minutes % stepMin === 0) ? (minutes / stepMin + 1) : Math.ceil(minutes / stepMin);
  else units = Math.ceil(minutes / stepMin);
  return units * (stepMin / 60);
}

// ---- 時間帯セグメント分解 ----
// 境界 = 深夜<6:00 / 早朝6-8 / 日中8-18 / 夜間18-22 / 深夜22- (service-selector と同一)
function parseHM(s) { const m = /^(\d{1,2}):(\d{2})/.exec((s || "").trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
function zoneOf(min) { if (min < 360 || min >= 1320) return "深"; if (min < 480) return "早"; if (min < 1080) return "日"; return "夜"; }
// 算定開始〜終了 を時間帯ごとの滞在(分)に clock 順で分解。
// 0時またぎ(e<=s)・解釈不能は null (単一時間帯 fallback に回す)。
function zoneSegments(startHM, endHM) {
  const s = parseHM(startHM), e = parseHM(endHM);
  if (s == null || e == null || e <= s) return null;
  const B = [360, 480, 1080, 1320].filter((b) => b > s && b < e);
  const cuts = [s, ...B, e];
  const segs = [];
  for (let i = 0; i < cuts.length - 1; i++) segs.push({ zone: zoneOf(cuts[i]), min: cuts[i + 1] - cuts[i] });
  return segs;
}

// master から single / single2 / composite / composite2 / increment / increment2 の
// 6 map を構築 (居宅介護 身体/家事 基本)
//   single      : 単一時間帯      key `${種別}|${日夜深早}|${時間.toFixed(2)}`
//   composite   : 時間帯またぎ合成 key `${種別}|${z1}${h1}・${z2}${h2}…` (clock順)
//   increment   : 時間帯単独の「増」区分 (例 家事夜増２．０) key `${種別}|${日夜深早}|${時間.toFixed(2)}`
//     ─ 2026-07-27 追加。単一 composite に無い長時間の時間帯またぎ (例: 家事 3 時間で
//       日 1.0h + 夜 2.0h にまたがるが、家事の合成コードは概ね 1.5h 総量までしか存在しない)
//       は、ほのぼの実データ突合の結果 「開始時間帯の通常コード(合算総時間) + 後続時間帯の
//       増コード(その時間帯だけの時間)」の 2 行立てで請求されることが判明 (茂原
//       1221008558 116131家事日3.0 + 116499家事夜増2.0)。increment/increment2 はその
//       「増」コード側のテーブル。
//   single2/composite2/increment2 : 各 ・2人 版 (単位は1人版と同一)
//   ・基(減額) と 跨増(日跨増深 等の特殊複合増分形) は茂原未使用のため除外。
async function loadCodeMaps() {
  const single = new Map(), single2 = new Map(), composite = new Map(), composite2 = new Map();
  const increment = new Map(), increment2 = new Map();
  const inMonth = (r) => (!r.valid_from || r.valid_from <= MONTH_FIRST) && (!r.valid_until || r.valid_until >= MONTH_FIRST);
  const segRe = /^(日|夜|深|早)(\d+\.\d+)$/;
  const incRe = /^(日|夜|深|早)増(\d+\.\d+)$/;
  const rows = [];
  // service_name の LIKE で取得 (身体/家事 基本のみ = 数百行、ページング安全)。
  // 旧 loadOfficialMap の code prefix OR + 大 range は statement timeout を踏むため name 起点にする。
  for (const pat of ["身体%", "家事%"]) {
    const part = await fetchAll(
      "kaigo_service_codes",
      "service_code,service_name,units,valid_from,valid_until",
      (q) => q.eq("system", "障害").eq("calculation_type", "基本").like("service_name", pat).order("service_code"),
    );
    rows.push(...part);
  }
  for (const r of rows.filter(inMonth)) {
    const raw = r.service_name || "";
    const nm = raw.normalize("NFKC");
    const km = /^(身体|家事)/.exec(nm);
    if (!km) continue;
    const kind = km[1];
    const parts = nm.slice(kind.length).split("・");
    let two = false, skip = false, isIncrement = false;
    const segs = [];
    for (const p of parts) {
      if (p === "2人") { two = true; continue; }
      if (p === "基") { skip = true; break; } // 基準該当(減額) は茂原未使用
      const im = incRe.exec(p);
      if (im && segs.length === 0 && !isIncrement) {
        // 「${zone}増${hours}」単独 (例 夜増２．０)。日跨増深 等の複合増分形は
        // この時点で im===null になり下の segRe 同様 skip される (対象外のまま)。
        isIncrement = true;
        segs.push({ zone: im[1], hours: Number(im[2]) });
        continue;
      }
      const sm = segRe.exec(p);
      if (!sm) { skip = true; break; } // 日跨増深 等の特殊増分形は対象外
      segs.push({ zone: sm[1], hours: Number(sm[2]) });
    }
    if (skip || segs.length === 0) continue;
    const val = { code: r.service_code, name: raw, units: r.units }; // name は raw(全角) — service_type 完全一致用
    if (isIncrement && segs.length === 1) {
      const key = `${kind}|${segs[0].zone}|${segs[0].hours.toFixed(2)}`;
      const map = two ? increment2 : increment;
      if (!map.has(key)) map.set(key, val);
    } else if (segs.length === 1) {
      const key = `${kind}|${segs[0].zone}|${segs[0].hours.toFixed(2)}`;
      const map = two ? single2 : single;
      if (!map.has(key)) map.set(key, val);
    } else {
      const key = `${kind}|` + segs.map((s) => `${s.zone}${s.hours.toFixed(2)}`).join("・");
      const map = two ? composite2 : composite;
      if (!map.has(key)) map.set(key, val);
    }
  }
  return { single, single2, composite, composite2, increment, increment2 };
}

// 021 稼働1行 → 障害6桁コード。twoPerson=true なら ・2人 コードへ。
//   単一時間帯: 算定開始の時間帯で single(2)。
//   またぎ    : 各区分に量子化配分 (先頭=floor(滞在/step)、末尾=残り) → composite(2) を引く。
//               ほのぼの照合: 身体またぎ(早日/日夜)は KJ の 111371/111375/111423/111427/111431
//               に回数まで一致。合成コード不在 (家事0.25セグ / 夜増 等) は算定開始時間帯の単一へ fallback。
function convertRow(code021, minutes, startHM, endHM, mode, maps, twoPerson) {
  const kind = code021 === "021001" ? "身体" : code021 === "021002" ? "家事" : null;
  if (!kind) return null;
  const step = kind === "身体" ? 30 : 15;
  const totalHours = quantizeHours(minutes, step, mode);
  const singleMap = twoPerson ? maps.single2 : maps.single;
  const compMap = twoPerson ? maps.composite2 : maps.composite;
  const startZoneK = ZONE_KANJI[zoneDigit(startHM).zone] || "日";
  const pickSingle = (zoneK, hours) => {
    const key = `${kind}|${zoneK}|${hours.toFixed(2)}`;
    const hit = singleMap.get(key);
    if (!hit) return { missing: true, key, twoPerson };
    return { base: hit.code, name: hit.name, units: hit.units, kind: "single", zone: zoneK, hours, key, twoPerson };
  };
  const segs = zoneSegments(startHM, endHM);
  if (!segs || segs.length <= 1) return pickSingle(startZoneK, totalHours);
  // 生の滞在分数が最大の時間帯 (同着は開始時間帯優先)。単一コードへ倒す際の fallback で使う。
  //   ★ 量子化(floor+残余配分)ではなく生分数で決めるのが重要 (詳細は下のコメント参照)。
  let majorityZone = segs[0].zone;
  let majorityMin = segs[0].min;
  for (let i = 1; i < segs.length; i++) {
    if (segs[i].min > majorityMin) { majorityMin = segs[i].min; majorityZone = segs[i].zone; }
  }
  // またぎ: 量子化配分 (先頭 floor, 末尾 = 総量 - 先頭群)
  const alloc = [];
  let sum = 0;
  for (let i = 0; i < segs.length; i++) {
    if (i < segs.length - 1) { const h = Math.floor(segs[i].min / step) * (step / 60); alloc.push({ zone: segs[i].zone, hours: h }); sum += h; }
    else alloc.push({ zone: segs[i].zone, hours: totalHours - sum });
  }
  const nz = alloc.filter((a) => a.hours > 1e-9);
  if (nz.length >= 2) {
    const key = `${kind}|` + nz.map((a) => `${a.zone}${a.hours.toFixed(2)}`).join("・");
    const hit = compMap.get(key);
    if (hit) return { base: hit.code, name: hit.name, units: hit.units, kind: "composite", zone: nz.map((a) => a.zone).join("・"), hours: totalHours, key, twoPerson };
    // 合成コード不在 (2026-07-27 是正: 家事は総量1.5h程度までしか合成コードが無く、
    //   それを超える時間帯またぎは「開始時間帯の通常コード(その時間帯の生分数) +
    //   後続時間帯の増コード(その時間帯の生分数)」の2行立てで請求される — 茂原
    //   1221008558 の実例 (116131家事日3.0 + 116499家事夜増2.0) で確認 (詳細は
    //   resolveBaseAddon 参照)。ここでは行内の各セグメントの「生の滞在分数」を
    //   そのまま使う (alloc の floor+残余配分ではなく zoneSegments の実分数)。
    const zoneMinutesOrdered = segs.map((s) => ({ zone: s.zone, minutes: s.min }));
    const resolved = resolveBaseAddon(kind, zoneMinutesOrdered, step, mode, maps, twoPerson);
    if (resolved && !resolved.missing) {
      return { ...resolved.base, addons: resolved.addons, fellBack: true, wantedKey: key };
    }
    // base/addon 側も解決できない場合は生の滞在分数が最大の時間帯の単一へ fallback
    //   (2026-07-27 是正: 従来は常に開始時間帯(startZoneK)固定だった。startZoneK は
    //   同着のときは majorityZone と一致するため、この行の変更で新たな退行は生じない)
    const s = pickSingle(majorityZone, totalHours);
    return { ...s, fellBack: true, wantedKey: key };
  }
  // 実質単一 (先頭 floor=0 等) — majorityZone (生の滞在分数が最大の時間帯) で引く。
  //   2026-07-27 fix: 従来は常に開始時間帯(startZoneK)で引いていたため、開始側の
  //   セグメントの方が短いケース (例: 家事 10分+20分。開始=日10分/後続=夜20分) で、
  //   実際は滞在時間の長い後続時間帯 (夜) に属するべき所要時間を誤って開始時間帯
  //   (日) のコードで解決してしまっていた (茂原 1221014788 家事夜0.5 が漏れて
  //   家事日0.5 が1件多く出ていた不具合)。
  //   ★ 「nz[0] (量子化後に残った方)」ではなく「生分数の最大」で判定するのが重要:
  //   量子化(floor+残余配分)は常に最終セグメントに残余を寄せるため、生分数が同着
  //   (例: 身体 早15分+日15分) のケースで nz[0] 判定だと常に後続側に倒れてしまい、
  //   林美紀(1221022690)の 身体早０．５ (実データで開始側=早朝が正解、KJ 111195×9
  //   で確認) を誤って身体日０．５に倒す regression を起こす。生分数比較+同着は
  //   開始時間帯優先とすることで、この 2 例を両立して正しく解決できる。
  return pickSingle(majorityZone, totalHours);
}

// 時間帯ごとの「生の分数」(alloc の floor/残余配分ではなく実際の滞在分数、または
// 同日合算セッションで複数訪問を合算した分数) から base(通常コード) + addon(増コード*)
// を解決する。zoneMinutesOrdered は時系列で先頭の時間帯が [0] に来るよう並べること
// (先頭 = base、以降 = 各々 addon)。
//   ★ 要確認: 単独行 (時間帯またぎだが同日合算セッションではない単発行) がこの経路に
//   落ちるケースは、実データでの直接検証ができていない (茂原の実例は常に同日複数回
//   提供の合算セッション経由だった)。合算セッションでの base/addon 値は実データ
//   (KJ) と単位まで一致確認済み。
function resolveBaseAddon(kind, zoneMinutesOrdered, step, mode, maps, twoPerson) {
  const singleMap = twoPerson ? maps.single2 : maps.single;
  const incMap = twoPerson ? maps.increment2 : maps.increment;
  const entries = zoneMinutesOrdered.filter((e) => e.minutes > 1e-9);
  if (entries.length === 0) return { missing: true, key: `${kind}|(no-minutes)` };
  const [baseEntry, ...restEntries] = entries;
  const baseHours = quantizeHours(baseEntry.minutes, step, mode);
  const baseKey = `${kind}|${baseEntry.zone}|${baseHours.toFixed(2)}`;
  const baseHit = singleMap.get(baseKey);
  if (!baseHit) return { missing: true, key: baseKey };
  const base = {
    base: baseHit.code, name: baseHit.name, units: baseHit.units,
    kind: "base", zone: baseEntry.zone, hours: baseHours, key: baseKey, twoPerson,
  };
  const addons = [];
  for (const e of restEntries) {
    const hours = quantizeHours(e.minutes, step, mode);
    if (hours <= 1e-9) continue;
    const key = `${kind}|${e.zone}|${hours.toFixed(2)}`;
    const hit = incMap.get(key);
    if (!hit) { addons.push({ missing: true, key, twoPerson }); continue; }
    addons.push({ base: hit.code, name: hit.name, units: hit.units, kind: "addon", zone: e.zone, hours, key, twoPerson });
  }
  return { base, addons };
}

// "HH:MM" → 当日分 (0時またぎは非対応。障害の訪問は同日内前提)
function toMinOfDay(hm) {
  const m = /^(\d{1,2}):(\d{2})/.exec((hm || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// ---- 同日合算セッション (概ね2時間未満の間隔ルール) ----
//   障害福祉サービス(居宅介護)の報酬告示上、同一日に同一区分(身体/家事)のサービスを
//   複数回提供し、その間隔が概ね2時間未満のときは1回の提供とみなして所要時間を
//   合算する (介護保険 訪問介護の「2時間ルール」と同趣旨)。
//   ★ 要確認: 閾値(120分)と「概ね」の運用、3セッション以上・2人体制との同時発生、
//   単独行での時間帯またぎ増分(resolveBaseAddon 単独経路)との相互作用は
//   実データ1件 (茂原 1221008558) からの類推であり未検証。2人体制の行
//   (_twoPerson=true) は合算対象から除外し安全側でスキップする。
const MERGE_GAP_MINUTES = 120;
function buildDailySessions(rows) {
  // rows: 同一 clientNum×date×kind (021001/021002) の候補行 (_twoPerson=false のみ渡すこと)
  const withTimes = rows
    .map((r) => ({ r, s: toMinOfDay(r.santeiStart), e: toMinOfDay(r.santeiEnd) }))
    .filter((it) => it.s != null && it.e != null && it.e > it.s)
    .sort((a, b) => a.s - b.s || a.e - b.e);
  const sessions = [];
  let cur = null;
  for (const it of withTimes) {
    if (cur && it.s - cur.lastEnd < MERGE_GAP_MINUTES) {
      cur.members.push(it.r);
      cur.lastEnd = Math.max(cur.lastEnd, it.e);
    } else {
      cur = { members: [it.r], lastEnd: it.e };
      sessions.push(cur);
    }
  }
  return sessions.map((s) => s.members);
}

// 合算セッション(2件以上)を base+addon に変換する。各メンバーの zoneSegments (または
// 単一時間帯ならその時間帯まるごと) の生分数を時系列順に積み上げてから resolveBaseAddon へ。
function convertSession(members, mode, maps) {
  const kind = members[0].code === "021001" ? "身体" : members[0].code === "021002" ? "家事" : null;
  if (!kind) return null;
  const step = kind === "身体" ? 30 : 15;
  const zoneOrder = []; // 時系列で初出順の zone
  const zoneMinutes = new Map();
  for (const r of members) {
    const minutes = santeiToMinutes(r.santei);
    if (minutes == null) continue;
    const segs = zoneSegments(r.santeiStart, r.santeiEnd);
    const parts = segs && segs.length > 0
      ? segs
      : [{ zone: ZONE_KANJI[zoneDigit(r.santeiStart).zone] || "日", min: minutes }];
    for (const p of parts) {
      if (!zoneMinutes.has(p.zone)) { zoneMinutes.set(p.zone, 0); zoneOrder.push(p.zone); }
      zoneMinutes.set(p.zone, zoneMinutes.get(p.zone) + p.min);
    }
  }
  const zoneMinutesOrdered = zoneOrder.map((zone) => ({ zone, minutes: zoneMinutes.get(zone) }));
  return resolveBaseAddon(kind, zoneMinutesOrdered, step, mode, maps, false);
}

// ---- ページング ----
async function fetchAll(table, cols, filter) {
  const out = []; const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(table).select(cols).range(from, from + PAGE - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

// ============================================================================
async function main() {
  console.log(`=== MEISAI 障害取込 ${EXECUTE ? "【本番 EXECUTE】" : "【DRY RUN】"} 対象月=${TARGET_MONTH} 事業所=${AREA_DIR} ===\n`);

  // 1) CSV
  const files = readdirSync(CSV_DIR).filter((f) => /^MEISAI_.*\.csv$/i.test(f));
  const all = [];
  for (const f of files) {
    const { idx, rows } = readCsv(path.join(CSV_DIR, f));
    for (const c of rows) {
      const g = (name) => (idx[name] != null ? (c[idx[name]] || "").trim() : "");
      all.push({
        file: f,
        jigyoNum: g("事業所番号"),
        staffName: g("職員名"),
        clientName: g("利用者名"),
        date: g("日付").replace(/\//g, "-"),
        start: g("派遣開始時間"),
        end: g("派遣終了時間"),
        svcName: g("サービス"),
        santei: g("算定時間"),
        santeiStart: g("算定開始時刻") || g("派遣開始時間"),
        santeiEnd: g("算定終了時刻") || g("派遣終了時間"),
        jikantai: g("時間帯"),
        holiday: g("休日区分"),
        code: g("サービスコード"),
        clientNum: g("利用者番号"),
      });
    }
  }
  const target = all.filter((r) => /^021/.test(r.code));
  console.log(`CSV: ${files.length}ファイル / 全${all.length}行 / 障害021対象 ${target.length}行`);
  const uniqNums = [...new Set(target.map((r) => r.clientNum))];
  console.log(`障害利用者: ${uniqNums.length}名\n`);

  // 事業所番号チェック
  const badBn = target.filter((r) => r.jigyoNum !== OFFICE_BN);
  if (badBn.length) console.warn(`⚠ 事業所番号が想定(${OFFICE_BN})と異なる行が ${badBn.length} 件`);

  // 2) 事業所
  const { data: offRows, error: offErr } = await sb
    .from("offices").select("id,name,tenant_id,service_type,business_number").eq("id", OFFICE_ID);
  if (offErr) throw new Error(`offices: ${offErr.message}`);
  if (!offRows.length) { console.error(`✗ 事業所 ${OFFICE_ID} が見つからない`); process.exit(1); }
  const office = offRows[0];
  console.log(`事業所: ${office.name} (${office.id}) tenant=${office.tenant_id}\n`);

  // 3) 時間区分モード
  const mode = await getTimeBracketMode();
  console.log(`時間区分モード: ${mode} (${mode === "honobono" ? "境界=下位区分" : "境界=上位区分"})\n`);

  // 4a) 2人派遣の検出 (同一 利用者×日×code の複数行のうち「時間帯が重複する」もの = 同時2人派遣)
  //   ★ ほのぼの請求ルール (KJ 実データで確認): 2人派遣は KJ(明細) に
  //     「基本コード(111111 等) 1行 + ・2人コード(111112 等) 1行」= 両ヘルパー分を2行で請求 (合計2倍)。
  //     (宮田 1242211371: 111111×48 + 111112×48 = 2倍)。
  //   → 稼働の2行は畳まず両方残し、「長い方」=基本コード(自身の所要時間) /
  //     「短い方」=・2人コード(自身の所要時間) に割当てる。
  //   ★ 2026-07-27 是正 (要件 #3「部分重複2人=終了時刻違い」): 旧実装は
  //     client+date+start+end+code の完全一致キーでグループ化しており、開始時刻は
  //     同じでも終了時刻が異なる部分重複ペア (例 16:00-17:30 と 16:00-18:00) や、
  //     一方が他方に内包されるペア (例 07:20-09:30 と 09:10-09:30) を検出できず
  //     両方とも solo 扱いになっていた (茂原 1221019043 で15件確認)。
  //     → 完全一致ではなく「時間区間が重なるか (start1<end2 && start2<end1)」で判定する
  //     sweep 方式に変更。区間が重ならない (例: 朝07:20-09:30 と 夕16:00-18:00) 組は
  //     従来どおり別々の solo として扱われ、動作は変わらない (回帰リスクなし)。
  //     重複ペアが「所要時間が同着(引き分け)」の場合は出現順 1件目=基本 (従来どおり)。
  //   ★ 2026-07-31 是正: グループ化キーに code が入っており、**コードが違う重なりを
  //     検出できなかった**。2人派遣は「同じサービスを2人で」とは限らず、
  //     一方が合成コード・他方が単独コードになるのが普通 (茂原 1221019043 樋口:
  //     07:20-09:30「身体早0.5・日2.0」に 09:10-09:30「身体日0.5」が内包される)。
  //     前回 sweep 方式にした際、この利用者で確認したと書かれているのにキーは
  //     code 込みのままで、sweep が同一コード内でしか働いていなかった。
  //     → キーを 利用者×日 にして、コードをまたいで時間重複を判定する。
  const byClientDay = new Map();
  for (const r of target) {
    const k = `${r.clientNum}|${r.date}`;
    if (!byClientDay.has(k)) byClientDay.set(k, []);
    byClientDay.get(k).push(r);
  }
  const byClientDayCode = byClientDay;
  let twoPersonVisits = 0, threePlus = 0, secondRows = 0;
  for (const grp of byClientDayCode.values()) {
    const withTimes = grp
      .map((r, i) => ({ r, i, s: toMinOfDay(r.santeiStart), e: toMinOfDay(r.santeiEnd) }))
      .sort((a, b) => (a.s ?? 0) - (b.s ?? 0) || (a.e ?? 0) - (b.e ?? 0));
    // 区間重複 sweep: 現在の重複ブロックの最大終了時刻より前に開始する行は同ブロック
    const blocks = [];
    let cur = null;
    for (const it of withTimes) {
      if (it.s == null || it.e == null) { blocks.push([it]); cur = null; continue; } // 時刻不明は単独
      if (cur && it.s < cur.maxEnd) { cur.members.push(it); cur.maxEnd = Math.max(cur.maxEnd, it.e); }
      else { cur = { members: [it], maxEnd: it.e }; blocks.push(cur.members); }
    }
    for (const members of blocks) {
      if (members.length >= 2) {
        twoPersonVisits++;
        if (members.length >= 3) threePlus++;
        // 所要時間 降順 (長い方=基本/短い方以降=・2人)。同着は出現順 (旧仕様どおり)。
        const ordered = [...members].sort((a, b) => (b.e - b.s) - (a.e - a.s) || a.i - b.i);
        ordered.forEach((it, idx) => { it.r._blockFirst = idx === 0; it.r._twoPerson = idx > 0; });
        secondRows += members.length - 1;
      } else {
        members[0].r._twoPerson = false; members[0].r._blockFirst = true;
      }
    }
  }
  if (threePlus) console.warn(`⚠ 3人以上の同時重複ブロックが ${threePlus} 件 — 2番目以降を全て ・2人 で計上 (・3人 コードは未対応。要確認)`);

  // 4a.5) 同日合算セッション (概ね2時間未満の間隔ルール。要件 #1「家事夜増2.0」是正)
  //   2人派遣行 (_twoPerson=true) は合算対象から除外 (安全側。相互作用未検証のため)。
  const sessionByClientDayKind = new Map();
  for (const r of target) {
    if (r._twoPerson) continue;
    const kind = r.code === "021001" ? "身体" : r.code === "021002" ? "家事" : null;
    if (!kind) continue;
    const k = `${r.clientNum}|${r.date}|${kind}`;
    if (!sessionByClientDayKind.has(k)) sessionByClientDayKind.set(k, []);
    sessionByClientDayKind.get(k).push(r);
  }
  const sessionOf = new Map(); // row -> members[] (2件以上のときのみ設定)
  let mergedSessionCount = 0, mergedRowCount = 0;
  for (const rows of sessionByClientDayKind.values()) {
    const sessions = buildDailySessions(rows);
    for (const members of sessions) {
      if (members.length < 2) continue;
      mergedSessionCount++; mergedRowCount += members.length;
      for (const r of members) sessionOf.set(r, members);
    }
  }
  if (mergedSessionCount) console.log(`同日合算セッション: ${mergedSessionCount} 件 (対象 ${mergedRowCount} 行 → 2時間未満間隔の同区分提供を合算)\n`);

  // 4b) map をロードして変換
  const maps = await loadCodeMaps();
  console.log(`コード map: single=${maps.single.size} single2=${maps.single2.size} composite=${maps.composite.size} composite2=${maps.composite2.size} increment=${maps.increment.size} increment2=${maps.increment2.size} (居宅介護 身体/家事 基本)`);
  console.log(`2人派遣ブロック: ${twoPersonVisits} 件 (・2人 行 ${secondRows} = 2人目以降を全て請求計上)\n`);
  const rowConv = []; // target と同じ index。各要素: null | { minutes, convs:[conv,...] } | { skip: true } (合算セッションの2件目以降)
  const convWarn = [];
  const missKeys = new Set();
  let blockedNoDur = 0, blocked6 = 0, compositeCount = 0, twoPersonCount = 0, fellBackCount = 0, addonCount = 0;
  const sessionResultCache = new Map(); // members(配列参照) -> {conv結果 or null}
  for (const r of target) {
    const session = sessionOf.get(r);
    if (session) {
      // 合算セッションの代表行 = session[0] (buildDailySessions で開始時刻昇順に格納済)。
      // 代表行以外は payload を出さない (二重計上防止。base+addon は代表行の1回だけ生成)。
      if (r !== session[0]) { rowConv.push({ skip: true }); continue; }
      if (!sessionResultCache.has(session)) sessionResultCache.set(session, convertSession(session, mode, maps));
      const resolved = sessionResultCache.get(session);
      if (!resolved || resolved.missing) {
        convWarn.push(`合算セッション 6桁未解決 key=${resolved?.key ?? "?"} (${r.clientName} ${r.date} 合算${session.length}件)`);
        if (resolved?.key) missKeys.add(resolved.key);
        rowConv.push(null); blocked6++; continue;
      }
      const convs = [resolved.base];
      for (const a of resolved.addons) {
        if (a.missing) { convWarn.push(`合算セッション 増コード未解決 key=${a.key} (${r.clientName} ${r.date})`); missKeys.add(a.key); continue; }
        convs.push(a); addonCount++;
      }
      const totalMinutes = session.reduce((s, m) => s + (santeiToMinutes(m.santei) ?? 0), 0);
      rowConv.push({ minutes: totalMinutes, convs, sessionMembers: session });
      continue;
    }
    const minutes = santeiToMinutes(r.santei);
    if (minutes == null) { convWarn.push(`算定時間が解釈不能: "${r.santei}" (${r.clientName} ${r.date})`); rowConv.push(null); blockedNoDur++; continue; }
    const conv = convertRow(r.code, minutes, r.santeiStart, r.santeiEnd, mode, maps, r._twoPerson);
    if (!conv || conv.missing) {
      convWarn.push(`6桁未解決 code=${r.code} ${minutes}分 ${r.santeiStart}-${r.santeiEnd}${r._twoPerson ? " [2人]" : ""} key=${conv?.key ?? "?"} (${r.clientName} ${r.date})`);
      if (conv?.key) missKeys.add(conv.key);
      rowConv.push(null); blocked6++; continue;
    }
    if (conv.kind === "composite") compositeCount++;
    if (conv.twoPerson) twoPersonCount++;
    if (conv.fellBack) {
      fellBackCount++;
      const addonNote = conv.addons ? ` + addon×${conv.addons.length}` : " (単一fallback)";
      convWarn.push(`合成コード不在→base+addon wanted=${conv.wantedKey} → ${conv.base}${conv.name}${addonNote} (${r.clientName} ${r.date} ${r.santeiStart}-${r.santeiEnd})`);
    }
    const convs = [conv];
    if (conv.addons) {
      for (const a of conv.addons) {
        if (a.missing) { convWarn.push(`増コード未解決 key=${a.key} (${r.clientName} ${r.date})`); missKeys.add(a.key); continue; }
        convs.push(a); addonCount++;
      }
    }
    rowConv.push({ minutes, convs });
  }

  // 変換後コード別 件数 (base/addon 両方をカウント)
  const convCount = {};
  for (let i = 0; i < target.length; i++) {
    const rc = rowConv[i];
    if (!rc || rc.skip || !rc.convs) continue;
    for (const c of rc.convs) {
      const tag = c.kind === "composite" ? "[またぎ]" : c.kind === "addon" ? "[増addon]" : c.twoPerson ? "[2人]" : rc.sessionMembers ? "[合算base]" : "";
      const key = `${target[i].code} ${rc.minutes}分 ${tag}\t→ ${c.base} ${c.name} (${c.units}単位)`;
      convCount[key] = (convCount[key] || 0) + 1;
    }
  }
  console.log("=== 021 → 公式6桁コード 変換件数 (合成/2人/合算/増addon タグ付き) ===");
  for (const [k, v] of Object.entries(convCount).sort()) console.log(`  ${k}\t×${v}`);
  console.log(`\n変換内訳: 時間帯またぎ合成=${compositeCount} / ・2人=${twoPersonCount} / 合成不在fallback=${fellBackCount} / 増addon=${addonCount} / 合算セッション=${mergedSessionCount}`);
  if (missKeys.size) console.log(`\n⚠ 6桁未解決キー ${missKeys.size}種: ${[...missKeys].join(" / ")}\n   (該当行は取込skip → 再diffで確認)`);
  if (convWarn.length) { console.log(`\n変換警告 ${convWarn.length}件 (先頭20):`); for (const w of convWarn.slice(0, 20)) console.log("  - " + w); }
  console.log("");

  // 5) 利用者マッピング
  let numToClient = {};
  try {
    const mapPath = fileURLToPath(new URL(`./_meisai_num_to_client_${MAP_TAG}.json`, import.meta.url));
    numToClient = JSON.parse(readFileSync(mapPath, "utf8"));
  } catch { console.warn(`⚠ マッピング ./_meisai_num_to_client_${MAP_TAG}.json 読込不可 — 氏名一致のみで解決`); }

  // 氏名逆引き (mapping に無い分)
  const clients = await fetchAll("clients", "id,name");
  const clientByName = new Map();
  for (const c of clients) { const k = normClientName(c.name); if (!clientByName.has(k)) clientByName.set(k, []); clientByName.get(k).push(c.id); }
  const nameByNum = {}; for (const r of target) nameByNum[r.clientNum] = r.clientName;

  const resolvedClient = new Map(); // clientNum -> client_id
  const unresolvedClients = [];
  for (const num of uniqNums) {
    if (numToClient[num]) { resolvedClient.set(num, numToClient[num]); continue; }
    const hits = clientByName.get(normClientName(nameByNum[num])) || [];
    if (hits.length === 1) { resolvedClient.set(num, hits[0]); continue; }
    unresolvedClients.push(`${num} ${nameByNum[num]} (氏名一致=${hits.length})`);
  }
  console.log(`=== 利用者 client_id 解決: ${resolvedClient.size}/${uniqNums.length}名 ===`);
  if (unresolvedClients.length) {
    console.log(`未解決 ${unresolvedClients.length}名 (受給者証取込で clients 登録後に再解決):`);
    for (const u of unresolvedClients) console.log("  - " + u);
  }
  console.log("");

  // 6) 職員 members.id
  const members = await fetchAll("members", "id,name");
  const memberByName = new Map();
  for (const m of members) { const k = normStaff(m.name); if (!memberByName.has(k)) memberByName.set(k, []); memberByName.get(k).push(m.id); }
  const uniqStaff = [...new Set(target.map((r) => r.staffName))];
  const staffMissing = uniqStaff.filter((nm) => (memberByName.get(normStaff(nm)) || []).length !== 1);
  console.log(`=== 職員 members 一致: ${uniqStaff.length - staffMissing.length}/${uniqStaff.length} ===`);
  if (staffMissing.length) console.log(`未一致 (staff_id=null): ${staffMissing.join(" / ")}`);
  console.log("");

  // 7) payload 構築
  //   rc.convs が複数件のとき (時間帯またぎ増addon / 合算セッション) は同一訪問枠に対し
  //   base 行 + addon 行を別々の kaigo_visit_schedule 行として INSERT する
  //   (aggregate.ts は service_type 名の一致でしか集計しないため、コードごとに
  //   1 occurrence = 1 行が必要)。
  let blockedNoClient = 0, sessionSkipped = 0;
  const payloads = [];
  for (let i = 0; i < target.length; i++) {
    const r = target[i]; const rc = rowConv[i];
    if (!rc) continue; // 変換不可(算定時間/6桁未解決)は 4) で計上済み
    if (rc.skip) { sessionSkipped++; continue; } // 合算セッションの代表行以外
    const cid = resolvedClient.get(r.clientNum);
    if (!cid) { blockedNoClient++; continue; }

    // 合算セッションの代表行は複数メンバーにまたがるため、開始/終了は
    // メンバー全体のスパン、staff は全メンバーが同一スタッフに解決できた場合のみ設定
    // (異なる場合は null。★ 要確認: 誰の稼働として計上すべきかの厳密なルールは未検証)。
    let startTime = r.start || null;
    let endTime = r.end || null;
    let staffId = (memberByName.get(normStaff(r.staffName)) || []).length === 1
      ? memberByName.get(normStaff(r.staffName))[0]
      : null;
    if (rc.sessionMembers) {
      const members = rc.sessionMembers;
      startTime = members[0].start || members[0].santeiStart || startTime;
      const last = members[members.length - 1];
      endTime = last.end || last.santeiEnd || endTime;
      const staffIds = new Set(
        members.map((m) => {
          const ids = memberByName.get(normStaff(m.staffName)) || [];
          return ids.length === 1 ? ids[0] : null;
        }),
      );
      staffId = staffIds.size === 1 ? [...staffIds][0] : null;
    }

    for (const c of rc.convs) {
      payloads.push({
        user_id: cid,
        staff_id: staffId,
        visit_date: r.date,
        start_time: startTime,
        end_time: endTime,
        service_type: c.name, // 障害マスタ名(公式6桁) 完全一致 (aggregate が名前で拾う)
        status: "completed",
        office_id: office.id,
        tenant_id: TENANT_ID,
        notes: `[MEISAI障害取込 ${TARGET_MONTH} ${MAP_TAG} code=${c.base}]`,
      });
    }
  }
  // 2人派遣は 4a で 長い方=基本 / 短い方=・2人 として全行残す (畳まない)。ここでの再 dedup は不要。
  const deduped = payloads;

  console.log(`=== 取込可否サマリ (障害021 ${target.length}行) ===`);
  console.log(`  取込可能(=INSERT行): ${deduped.length}`);
  console.log(`  2人派遣: ${twoPersonVisits}件 (・2人 行 ${twoPersonCount} を基本行と別に計上=2倍請求)`);
  console.log(`  合算セッション: ${mergedSessionCount}件 (対象${mergedRowCount}行 → 代表行1件に集約、2件目以降 ${sessionSkipped}行はskip)`);
  console.log(`  増addon行: ${addonCount}`);
  console.log(`  ブロック(利用者未解決): ${blockedNoClient}`);
  console.log(`  ブロック(6桁コード未解決): ${blocked6}`);
  console.log(`  ブロック(算定時間不正): ${blockedNoDur}`);
  if (deduped[0]) console.log("\nINSERT payload サンプル:\n", JSON.stringify(deduped[0], null, 2));
  console.log("");

  if (!EXECUTE) { console.log("※ DRY RUN のため INSERT していません。--execute で本番投入。"); return; }

  // 冪等: 既存の障害取込行を削除
  const { error: delErr } = await sb.from("kaigo_visit_schedule").delete()
    .eq("office_id", office.id).like("notes", "[MEISAI障害取込%");
  if (delErr) { console.error(`✗ 既存削除失敗: ${delErr.message}`); process.exit(1); }
  console.log("既存 障害取込行 削除完了");

  const CH = 500; let done = 0;
  for (let i = 0; i < deduped.length; i += CH) {
    const chunk = deduped.slice(i, i + CH);
    const { error } = await sb.from("kaigo_visit_schedule").insert(chunk);
    if (error) { console.error(`✗ INSERT失敗 (${done}件済): ${error.message}`); process.exit(1); }
    done += chunk.length; console.log(`  ${done}/${deduped.length}`);
  }
  console.log(`✓ 完了: ${done}行 INSERT`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
