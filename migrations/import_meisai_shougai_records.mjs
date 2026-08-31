// ============================================================================
// ほのぼの「稼働データ」MEISAI CSV → kaigo_visit_schedule 障害実績取込
//   取込元: apps/kaigo-app/サービス実績データ/大網/202606/MEISAI_*.csv
//   取込先: kaigo_visit_schedule (status='completed' = 実績)。
//           請求の集計は service_type(=障害マスタの service_name 完全一致) で
//           shogai-seikyu/aggregate.ts が拾う。**system 列には依存していない。**
//
//   ⚠ 「kaigo_visit_schedule に system 列は無い」という以前の記載は誤り。列はある。
//     この script は system='障害' も入れる。請求額は変わらないが、シフト画面・
//     実績記録票・経営分析が制度で切れるようになる。
//     取込は当月ぶんを消して入れ直すので、**ここで入れないと取込のたびに消える**
//     (2026-08-30 に単発 script で付けた 3,624 件が実際に消えていた)。
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
import { findMeisaiFiles } from "./_meisai_files.mjs";
import { normClientName as normClientNameShared } from "./_meisai_name.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import iconv from "iconv-lite";

const EXECUTE = process.argv.includes("--execute");
/**
 * 重訪を MEISAI から取り込まない (TJ から入れる) モード。
 *
 * ⚠ MEISAI は **給与用**なので休憩が含まれる。
 *   09:00-12:00 + 12:00-13:00(休憩) + 13:00-17:00 = 8.0h
 *   請求できるのは提供時間だけなので、ほのぼのの実績記録票 (TJ) は 7.0h。
 *   MEISAI から起こすと休憩ぶんまで請求してしまう (おゆみ野だけで 213時間ぶん)。
 *
 *   → 過去分は `--skip-juho` を付けて MEISAI からは入れず、
 *     `import_juho_from_tj.mjs` で TJ から入れる。
 *   詳細は docs/TJ_JISSEKI_STRUCTURE.md
 */
const SKIP_JUHO = process.argv.includes("--skip-juho");
// TARGET_MONTH=2026-07 で対象月を切替 (既定は 2026-06)。
// MONTH_FIRST はサービスコードの世代判定 (validInMonth) に使うので必ず同じ月にする。
const TARGET_MONTH = process.env.TARGET_MONTH || "2026-06";
const MONTH_FIRST = `${TARGET_MONTH}-01`;
const YM = TARGET_MONTH.replace("-", "");
const AREA_DIR = process.env.AREA_DIR || "大網"; // 大網 稼働データは 介護 配下に同居
const OFFICE_ID = process.env.OFFICE_ID || "269d77bc-5b61-4114-a2ea-e8dc2f220823"; // リンクスヘルパーステーション大網白里
const OFFICE_BN = process.env.OFFICE_BN || "1275800892";
const TENANT_ID = "kt-group";
const MAP_TAG = process.env.MAP_TAG || "大網"; // _meisai_num_to_client_大網.json
// 月フォルダ配下を再帰で探す (障害の MEISAI が 介護/ に同居している拠点があるため)
const CSV_DIR = fileURLToPath(new URL(`../サービス実績データ/${AREA_DIR}/${YM}/`, import.meta.url));

// notes に埋め込む行種マーカー。**src/lib/shogai-seikyu/record-markers.ts と同一文字列**
//   (TS 側から .mjs を import できないため二重定義。変更時は両方直すこと)
//   - MARK_ADDON      : 増(加算)コードの行。請求には要るが実際の訪問ではないので実績記録票に出さない
//   - MARK_SESSION_SUB: 合算セッションの2件目以降。請求は代表行に集約済なので集計から除外し、
//                       実績記録票にだけ提供時刻の行として出す
const MARK_ADDON = "加算行";
const MARK_SESSION_SUB = "合算従属";

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
// 利用者名の正規化は _meisai_name.mjs に集約 (括弧なしの目印「移/障/支」を落とすため)
const normClientName = normClientNameShared;

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

// ほのぼの内部コード(021xxx) → マスタ名の種別。マスタ名の先頭がこの文字列になっている。
//   021003 重度介護 は「重訪Ⅱ日中８．０」のような**積み上げ型**で請求モデルが違うため
//   ここでは扱わない (別実装)。021005 行動援護 も同様に未対応。
const KIND_OF_021 = {
  "021001": "身体", // 身体介護 → 111xxx
  "021002": "家事", // 家事援助 → 116xxx / 117xxx
  "021007": "通院1", // 通院介助 (身体を伴う)   → 113xxx  例「通院１日２．０」
  //   ⚠ 値は **NFKC 後**の文字列 (半角数字)。マスタ名の raw は全角「通院１」だが
  //     parse は normalize("NFKC") してから種別判定するので "通院1" で持つ
  "021006": "通院2", // 通院介助 (身体を伴わない) → 117xxx  例「通院２早０．５・日１．０」
  "021008": "同援", // 同行援護 → 157xxx
  //   「同行等身体(自立)」= 身体介護を伴う同行援護。コード体系は 021008 と同じ 157xxx。
  //   実証 (いすみ 古茶みつ子 1244100770 / 2026-06):
  //     10:20-16:20 (6.0h) ×2 → 157967 同援日６．０・区４ ×2
  //     10:20-10:50 (0.5h)    → 157703 同援日０．５・区４
  //     15:20-16:20 (1.0h)    → 157727 同援日１．０・区４   ← 伝送と完全一致
  "021009": "同援", // 同行援護 (身体を伴う) → 157xxx
};

// 同行援護の内部コード。**どちらも障害支援区分でコードが変わる** (・区3 / ・区4)。
// 021009 を入れ忘れると素の 157951 (1,027単位) が出て、正の 157967 (1,438単位) にならない。
const DOUKOU_CODES = new Set(["021008", "021009"]);

// 同行援護は障害支援区分でコードが変わる。
//   ⚠ **「区4」は区分4以上**の意味 (実データ: 稲生大輝=区分6 に 157703「同援日０．５・区４」)。
//   区分1-2 = 修飾子なし / 区分3 = 区3 / 区分4以上 = 区4。
function doukouKubunMod(supportLevel) {
  const m = /区分\s*([1-6１-６])/.exec((supportLevel || "").normalize("NFKC"));
  if (!m) return null;
  const n = Number(m[1].normalize("NFKC"));
  return n >= 4 ? "区4" : n === 3 ? "区3" : null;
}

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
// natural と同じ合計 step 数を保ったまま、各要素 1 以上・ずれ 2 step 以内の配分を
// ずれの小さい順に列挙する (natural 自身は除く)。時間帯は最大 4 つなので全探索でよい。
// ⚠ src/lib/shogai-seikyu/code-from-time.ts の nearbyAllocations と同じ規則にすること。
function nearbyAllocations(natural, totalUnits) {
  const n = natural.length;
  if (n < 2 || totalUnits < n) return [];
  const out = [];
  const cur = [];
  const walk = (i, left) => {
    if (i === n - 1) {
      if (left < 1 || Math.abs(left - natural[i]) > 2) return;
      const a = [...cur, left];
      const d = a.reduce((s, v, k) => s + Math.abs(v - natural[k]), 0);
      if (d > 0) out.push({ a, d });
      return;
    }
    const lo = Math.max(1, natural[i] - 2);
    const hi = Math.min(natural[i] + 2, left - (n - 1 - i));
    for (let v = lo; v <= hi; v++) { cur.push(v); walk(i + 1, left - v); cur.pop(); }
  };
  walk(0, totalUnits);
  out.sort((x, y) => x.d - y.d);
  return out.map((x) => x.a);
}

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
  for (const pat of ["身体%", "家事%", "同援%", "通院１%", "通院２%"]) {
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
    // ⚠ 「通院１」「通院２」は先に判定する (「通院」だけだと数字が時間と誤認される)
    const km = /^(身体|家事|同援|通院[12])/.exec(nm);
    if (!km) continue;
    const kind = km[1];
    const parts = nm.slice(kind.length).split("・");
    let two = false, skip = false, isIncrement = false;
    const mods = []; // 同援の 区3/区4 等。身体/家事 では常に空
    const segs = [];
    for (const p of parts) {
      if (p === "2人") { two = true; continue; }
      if (p === "基") { skip = true; break; } // 基準該当(減額) は茂原未使用
      // 同援の修飾子。KT Group が算定しているのは区分のみ (基礎/盲ろう/通訳/補正 は
      //   実データに無い) なので、それらが付くコードは対象外にして誤ヒットを防ぐ
      if (kind === "同援" && /^区[0-9]$/.test(p)) { mods.push(p); continue; }
      if (kind === "同援" && (p === "基礎" || p === "盲ろう" || p === "通訳" || p.includes("補正"))) { skip = true; break; }
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
    const mk = mods.sort().join("・");
    if (isIncrement && segs.length === 1) {
      const key = `${kind}|${segs[0].zone}|${segs[0].hours.toFixed(2)}|${mk}`;
      const map = two ? increment2 : increment;
      if (!map.has(key)) map.set(key, val);
    } else if (segs.length === 1) {
      const key = `${kind}|${segs[0].zone}|${segs[0].hours.toFixed(2)}|${mk}`;
      const map = two ? single2 : single;
      if (!map.has(key)) map.set(key, val);
    } else {
      const key = `${kind}|` + segs.map((s) => `${s.zone}${s.hours.toFixed(2)}`).join("・") + `|${mk}`;
      const map = two ? composite2 : composite;
      if (!map.has(key)) map.set(key, val);
    }
  }
  // ── 重度訪問介護 (021003) の段テーブル ──
  //   居宅介護・同行援護と請求モデルが違う。**所要時間までの段を全部出す積み上げ型**で、
  //   単位は各段の増分。1.5h の訪問なら 1.0h(202単位) + 1.5h(99単位) の 2 行を出す。
  //   (五井 粥米利之 1.5h×8 + 2.0h×2 → 301×8 + 401×2 = 3,210 が伝送と完全一致)
  //
  //   ⚠ マスタ名の文法が居宅介護と違う:
  //     - 時間帯が **2 文字** (日中/夜間/深夜/早朝)。居宅介護は 1 文字 (日/夜/深/早)
  //     - **NFKC が「Ⅱ」を「II」に分解する**ので正規表現は `重訪(I{1,3})?` で書く
  //       (`重訪(Ⅰ|Ⅱ|Ⅲ)?` は NFKC 後の文字列にマッチせず解析成功 0 件になる)
  //   入院等/90日減/同行 付きの派生 (1,792件) は KT Group 未算定のため対象外。
  const juhoSteps = new Map(); // `${区分}|${時間帯}|${2人?1:0}` -> [{hours, code, units}] (時間昇順)
  {
    const rows2 = await fetchAll(
      "kaigo_service_codes",
      "service_code,service_name,units,valid_from,valid_until",
      (q) => q.eq("system", "障害").eq("calculation_type", "基本").like("service_name", "重訪%").order("service_code"),
    );
    const seenCode = new Set();
    for (const r of rows2.filter(inMonth)) {
      if (seenCode.has(r.service_code)) continue;
      seenCode.add(r.service_code);
      const n = (r.service_name || "").normalize("NFKC");
      const m = /^重訪(I{1,3})?(日中|夜間|深夜|早朝)([0-9]+\.[0-9]+)(.*)$/.exec(n);
      if (!m) continue;
      const rest = m[4];
      // 修飾子は ・2人 のみ許可 (入院等・90日減・同行 等は対象外)
      let two = false, skip = false;
      for (const p of rest.split("・").filter(Boolean)) {
        if (p === "2人") { two = true; continue; }
        skip = true; break;
      }
      if (skip) continue;
      const key = `${m[1] || ""}|${m[2]}|${two ? 1 : 0}`;
      if (!juhoSteps.has(key)) juhoSteps.set(key, []);
      juhoSteps.get(key).push({ hours: Number(m[3]), code: r.service_code, name: r.service_name, units: r.units });
    }
    for (const arr of juhoSteps.values()) arr.sort((a, b) => a.hours - b.hours);
  }

  return { single, single2, composite, composite2, increment, increment2, juhoSteps };
}

// 021 稼働1行 → 障害6桁コード。twoPerson=true なら ・2人 コードへ。
//   単一時間帯: 算定開始の時間帯で single(2)。
//   またぎ    : 各区分に量子化配分 (先頭=floor(滞在/step)、末尾=残り) → composite(2) を引く。
//               ほのぼの照合: 身体またぎ(早日/日夜)は KJ の 111371/111375/111423/111427/111431
//               に回数まで一致。合成コード不在 (家事0.25セグ / 夜増 等) は算定開始時間帯の単一へ fallback。
// mods = 修飾子 (同援の 区3/区4 等)。身体/家事 では常に空配列
function convertRow(code021, minutes, startHM, endHM, mode, maps, twoPerson, mods = []) {
  // 重度訪問介護 (021003) は日次通算なので、この行単位の変換器では扱わない
  //   (main の juhoByDay で日ごとにまとめて解決する)
  if (code021 === "021003") return null;
  const kind = KIND_OF_021[code021] ?? null;
  if (!kind) return null;
  // 量子化の刻み: 身体/同援 = 0.5h (30分) / 家事 = 0.25h (15分)
  const step = kind === "家事" ? 15 : 30;
  const mk = [...mods].sort().join("・");
  const totalHours = quantizeHours(minutes, step, mode);
  const singleMap = twoPerson ? maps.single2 : maps.single;
  const compMap = twoPerson ? maps.composite2 : maps.composite;
  const startZoneK = ZONE_KANJI[zoneDigit(startHM).zone] || "日";
  const pickSingle = (zoneK, hours) => {
    const key = `${kind}|${zoneK}|${hours.toFixed(2)}|${mk}`;
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
  // (nearbyAllocations は下の合成コード探索で使う。lib/shogai-seikyu/code-from-time.ts と同じ規則)
  // またぎ: 先行する時間帯は **四捨五入 (0.5 は切り上げ)**、末尾に残りを寄せる。
  //   2026-08-04 是正: 従来は先行を floor していたため step 未満の先頭区分が消えていた。
  //   ほのぼの実データで確定した配分規則 (3 例が同時に成立するのはこの規則だけ):
  //     姉ム 森田汐音 07:40-08:40 早20/日40 総2step → 早 round(0.67)=1, 日 1
  //         → 身体早０．５・日０．５ (111363)   ※旧 floor だと早が消え 身体日１．０
  //     茂原 樋口颯太 07:20-09:30 早40/日90 総5step → 早 round(1.33)=1, 日 4
  //         → 身体早０．５・日２．０ (111375)   ※最大剰余法だと早に余りが行き 111391 で誤り
  //     茂原 林美紀   07:45-08:15 早15/日15 総1step → 早 round(0.5)=1, 日 0
  //         → 身体早０．５ (111195・単一)
  //   末尾が 0 step になったら単一時間帯として扱われる (nz の filter で落ちる)。
  //   ⚠ **15 分未満の端数はその時間帯として数えない** (障害の最小単位が 15 分)。
  //     やわた 杉浦天来 07:50-09:20 早10/日80 → 早は数えず **家事日１．５** (116119)
  //     ほのぼのもそう出している。比率ではなく絶対 15 分が境目で、round/floor では
  //     説明できない (早20分/step30 は数える = 森田汐音、早10分/step15 は数えない)。
  const segs2 = segs.filter((s) => s.min >= 15);
  if (segs2.length <= 1) return pickSingle(segs2[0]?.zone ?? majorityZone, totalHours);
  const stepsTotal = Math.round((totalHours * 60) / step);
  const alloc = [];
  let used = 0;
  for (let i = 0; i < segs2.length; i++) {
    const n = i < segs2.length - 1
      ? Math.min(Math.round(segs2[i].min / step), Math.max(0, stepsTotal - used))
      : Math.max(0, stepsTotal - used);
    used += n;
    alloc.push({ zone: segs2[i].zone, hours: n * (step / 60) });
  }
  const nz = alloc.filter((a) => a.hours > 1e-9);
  if (nz.length >= 2) {
    const key = `${kind}|` + nz.map((a) => `${a.zone}${a.hours.toFixed(2)}`).join("・") + `|${mk}`;
    const hit = compMap.get(key);
    if (hit) return { base: hit.code, name: hit.name, units: hit.units, kind: "composite", zone: nz.map((a) => a.zone).join("・"), hours: totalHours, key, twoPerson };
    // 実在しない配分になったときは、**合計を保ったまま近い配分**を探す。
    //   マスタの合成は下限が 0.5h で `家事日０．２５・夜…` が存在しない。素直に配分すると
    //   引けず単一コードへ落ちて金額がずれていた。
    //     いすみ 田中康夫 17:45-18:45  日15/夜45 → 日0.25・夜0.75 (無い)
    //                                  → **日0.5・夜0.5** (116327) が ほのぼのと一致
    //     やわた 柳澤玲子 17:40-19:10  日20/夜70 → 日0.25・夜1.25 (無い)
    //                                  → **日0.5・夜1.0** (116331) が ほのぼのと一致
    //   ⚠ 各帯 1 step 以上・ずれ 2 step 以内だけ。遠くまで探すと下の base+増 2 行立て
    //     (茂原 1221008558 家事日3.0 + 家事夜増2.0) を壊す。
    for (const cand of nearbyAllocations(alloc.map((a) => Math.round((a.hours * 60) / step)), stepsTotal)) {
      const k2 = `${kind}|` + alloc.map((a, i) => `${a.zone}${(cand[i] * (step / 60)).toFixed(2)}`).join("・") + `|${mk}`;
      const h2 = compMap.get(k2);
      if (h2) {
        return { base: h2.code, name: h2.name, units: h2.units, kind: "composite",
          zone: alloc.map((a) => a.zone).join("・"), hours: totalHours, key: k2, twoPerson, shifted: key };
      }
    }
    // 合成コード不在 (2026-07-27 是正: 家事は総量1.5h程度までしか合成コードが無く、
    //   それを超える時間帯またぎは「開始時間帯の通常コード(その時間帯の生分数) +
    //   後続時間帯の増コード(その時間帯の生分数)」の2行立てで請求される — 茂原
    //   1221008558 の実例 (116131家事日3.0 + 116499家事夜増2.0) で確認 (詳細は
    //   resolveBaseAddon 参照)。ここでは行内の各セグメントの「生の滞在分数」を
    //   そのまま使う (alloc の floor+残余配分ではなく zoneSegments の実分数)。
    const zoneMinutesOrdered = segs2.map((s) => ({ zone: s.zone, minutes: s.min }));
    const resolved = resolveBaseAddon(kind, zoneMinutesOrdered, step, mode, maps, twoPerson, mk);
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
function resolveBaseAddon(kind, zoneMinutesOrdered, step, mode, maps, twoPerson, mk = "") {
  const singleMap = twoPerson ? maps.single2 : maps.single;
  const incMap = twoPerson ? maps.increment2 : maps.increment;
  const entries = zoneMinutesOrdered.filter((e) => e.minutes > 1e-9);
  if (entries.length === 0) return { missing: true, key: `${kind}|(no-minutes)` };
  const [baseEntry, ...restEntries] = entries;
  const baseHours = quantizeHours(baseEntry.minutes, step, mode);
  const baseKey = `${kind}|${baseEntry.zone}|${baseHours.toFixed(2)}|${mk}`;
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
    const key = `${kind}|${e.zone}|${hours.toFixed(2)}|${mk}`;
    const hit = incMap.get(key);
    if (!hit) { addons.push({ missing: true, key, twoPerson }); continue; }
    addons.push({ base: hit.code, name: hit.name, units: hit.units, kind: "addon", zone: e.zone, hours, key, twoPerson });
  }
  return { base, addons };
}

// ---- 重度訪問介護 (021003) の変換 ----
// **日次通算 + 積み上げ型**。制度上「1日 (0時〜24時) の所要時間を通算して算定」するため、
// 訪問1回ごとではなく **その日の合計時間** で段を積む。
//   段: 1.0h(202) 1.5h(99) 2.0h(100) 2.5h(100) 3.0h(100) 3.5h(99) 4.0h(100)
//       **4h超は 0.5h ごとに 8.0h のコード(92単位)を繰り返す** (12h/16h/20h/24h の段は
//       マスタ上の刻み境界であって、実際は 4h 超過分を 1 コードで回数計上する)
//
// 2人派遣: 同一日に**時間帯が重なる**訪問がある場合、重なり分が2人目。
//   1人目 = その日の和集合(union)の時間 / 2人目 = 重なった時間。それぞれ別に段を積む。
//
// 検算 (五井 水越圭彦 1221916057 / 12日分):
//   1人目 union 通算 → 121271×12 121281×12 121441×12 121451×12 121461×12 121471×12
//                      121481×9 121221×32  ← **伝送と回数まで完全一致**
//   (訪問ごとに積む旧実装では 121271×16 になり長時間の段が出なかった)
//
// ⚠ 時間帯: 算定開始時刻の時間帯でコード系列を選ぶ。五井は全訪問が日中に収まっており
//   時間帯またぎの実例が無いため未検証。
// ⚠ 区分: マスタは 重訪Ⅰ/Ⅱ/Ⅲ。五井は全員 Ⅱ (区分6)。対応表未確定のため既定 Ⅱ。
function juhoStepsFor(maps, zoneLabel, twoPerson, kubunRoman = "II") {
  return maps.juhoSteps.get(`${kubunRoman}|${zoneLabel}|${twoPerson ? 1 : 0}`) ?? null;
}

// 通算分数 → 使う段の配列 (4h 超は 8.0h コードを繰り返す)
function juhoStepsForMinutes(steps, minutes, mode) {
  const hours = quantizeHours(minutes, 30, mode);
  const base = steps.filter((st) => st.hours <= 4 + 1e-9 && st.hours <= hours + 1e-9);
  const out = [...base];
  if (hours > 4) {
    // 4h 超過分を 0.5h ごとに「8.0h」の段で計上する
    const over = steps.find((st) => Math.abs(st.hours - 8) < 1e-9);
    if (over) {
      const times = Math.round((hours - 4) / 0.5);
      for (let i = 0; i < times; i++) out.push(over);
    }
  }
  return out;
}

// ============================================================================
// 重度訪問介護の日次通算 (2026-08-30 に実伝送から確定したルール)
//
//   1. その日の重訪を **訪問順に並べて時間を累計**する
//      ⚠ 時刻が重なっても合算する。**2人派遣にしない**
//        (やわた 宮原和世: 13:00-18:30 と 16:30-18:30 が重なるが、ほのぼのは
//         121271 = 1人 で出している。当方は 121272 = ・2人 を出していた)
//   2. 累計 0〜4.0h は基本段 (1.0/1.5/…/4.0)
//   3. 4.0h 超は 30 分ごとの増分
//   いずれも
//      ・その時間が属する **時間帯** (早朝6-8 / 日中8-18 / 夜間18-22 / 深夜22-6)
//      ・段 = **「累計終了時刻 以上 で最小の段」**
//
//   ⚠ 「以上」がポイント。終了 8.0 を「8.0 を超えたから 8.5」と読むと合わない。
//     **8.0 ちょうどは 8.0 段**。
//
//   検算: やわた 宮原和世 2026-06 の 8 日分で 5 コードとも完全一致
//     121221 日中8.0 48 / 129025 日中8.5 4 / 121231 日中12.0 4
//     123221 夜間8.0 12 / 123231 夜間12.0 4
//   詳細は docs/TJ_JISSEKI_STRUCTURE.md
// ============================================================================

/** 累計(分)の終了位置に対応する段の hours を返す */
function juhoTierHoursForCumEnd(cumEndMin, tierHours) {
  const h = cumEndMin / 60;
  // 4.0h までは段が刻みそのもの (1.0 / 1.5 / … / 4.0)
  if (h <= 4 + 1e-9) {
    const exact = tierHours.find((t) => Math.abs(t - h) < 1e-9);
    if (exact != null) return exact;
  }
  // 4.0h 超は「累計終了 以上 で最小の段」
  return tierHours.find((t) => t > 4 + 1e-9 && t >= h - 1e-9) ?? null;
}

/**
 * 1 日ぶんの重訪の訪問 (訪問順・時刻つき) から算定コード列を作る。
 * @param visits [{s,e}] 分。開始時刻昇順
 * @param stepsByZone zoneLabel -> [{hours, code, name, units}]
 * @returns [{code,name,units,zone}] / 解決できなければ null
 */
function juhoConvsForDay(visits, stepsByZone, stepsByZone2 = null) {
  // ① 訪問順に、時間帯の境界で細切れにする
  //   v.n = その提供の人数 (TJ 由来。無ければ 1)。段は人数ぶん別のコード体系になる
  //   (末尾 1 = 1人 / 末尾 2 = 2人)。
  const segs = [];
  for (const v of visits) {
    let s = v.s;
    while (s < v.e) {
      const z = zoneOf(s);
      // その時間帯の終わり (分)
      const zEnd = z === "深" ? (s < 360 ? 360 : 1440) : z === "早" ? 480 : z === "日" ? 1080 : 1320;
      const e = Math.min(v.e, zEnd);
      if (e > s) segs.push({ zone: z, minutes: e - s, two: (v.n ?? 1) >= 2 });
      s = e;
    }
  }
  if (!segs.length) return null;

  // ② 段の境界で切りながら累計する
  const anyZone = Object.values(stepsByZone).find(Boolean);
  if (!anyZone) return null;
  const tierHours = [...new Set(anyZone.map((st) => st.hours))].sort((a, b) => a - b);
  const tierEndsMin = tierHours.map((h) => h * 60);

  const out = [];
  let cum = 0;
  for (const seg of segs) {
    let left = seg.minutes;
    while (left > 1e-9) {
      // 次の段の終了累計。4h までは段そのもの、超えたら 30 分刻み
      const next = cum < 240
        ? tierEndsMin.find((m) => m > cum + 1e-9 && m <= 240)
        : cum + 30;
      const boundary = next ?? cum + 30;
      const take = Math.min(left, boundary - cum);
      const cumEnd = cum + take;
      // 端数は 30 分に切り上げ (告示どおり)
      const billedEnd = cumEnd < 240 ? cumEnd : Math.ceil(cumEnd / 30) * 30;
      const th = juhoTierHoursForCumEnd(billedEnd, tierHours);
      const steps = (seg.two && stepsByZone2) ? stepsByZone2[seg.zone] : stepsByZone[seg.zone];
      if (th != null && steps) {
        const st = steps.find((x) => Math.abs(x.hours - th) < 1e-9);
        if (st) out.push({ code: st.code, name: st.name, units: st.units, zone: seg.zone, two: !!seg.two });
      }
      cum = cumEnd;
      left -= take;
    }
  }
  return out.length ? out : null;
}

// "HH:MM" → 当日分 (0時またぎは非対応。障害の訪問は同日内前提)
function toMinOfDay(hm) {
  const m = /^(\d{1,2}):(\d{2})/.exec((hm || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// 行の算定時刻を差し替える (2人派遣の 和集合 / 重なり への組み替え用)。
// 算定時間も一緒に書き換えないと santeiToMinutes が古い値を返して単位がずれる。
function setSpan(row, startMin, endMin) {
  const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const dur = endMin - startMin;
  row.santeiStart = hm(startMin);
  row.santeiEnd = hm(endMin);
  row.santei = `${String(Math.floor(dur / 60)).padStart(3, "0")}:${String(dur % 60).padStart(2, "0")}`;
}

// ---- 同日合算セッション (概ね2時間未満の間隔ルール) ----
//   障害福祉サービス(居宅介護)の報酬告示上、同一日に同一区分(身体/家事)のサービスを
//   複数回提供し、その間隔が概ね2時間未満のときは1回の提供とみなして所要時間を
//   合算する (介護保険 訪問介護の「2時間ルール」と同趣旨)。
//   ★ 要確認: 閾値(120分)と「概ね」の運用、3セッション以上・2人体制との同時発生、
//   単独行での時間帯またぎ増分(resolveBaseAddon 単独経路)との相互作用は
//   実データ1件 (茂原 1221008558) からの類推であり未検証。2人体制の行
//   (_twoPerson=true) は合算対象から除外し安全側でスキップする。
// 同日合算の間隔しきい値 (分)。MERGE_GAP_MINUTES=1 で「連続 (間隔 0) のみ合算」になる。
// 2026-06 の実データでの隣接ペアの間隔: 0分 8件 / 60分 2件 / 90分 5件 / 110分 1件。
const MERGE_GAP_MINUTES = Number(process.env.MERGE_GAP_MINUTES ?? 120);
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
// mods = 修飾子 (同援の 区3/区4 等)。身体/家事 では空
function convertSession(members, mode, maps, mods = []) {
  const kind = KIND_OF_021[members[0].code] ?? null;
  if (!kind) return null;
  const step = kind === "家事" ? 15 : 30;
  const mk = [...mods].sort().join("・");
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
  // ★ まず **合成コード**を試す。ほのぼのはヘルパーが交代しても 1 提供として 1 コードで出す。
  //     おゆみ野 小田響眞 6/26  07:00-08:15 (新木) + 08:15-09:00 (湯浅) = 114分
  //       → 111387 身体早１．０・日１．０ 1 件
  //     当方は base+addon に分けて 111199 身体早1.0 + 111831 身体日増1.0 を出していた。
  //   配分規則は convertRow のまたぎと同じ (先行は四捨五入・末尾に残りを寄せる)。
  //   合成が無いときだけ従来どおり base+addon に落とす (家事は 1.5h 程度までしか合成が無い)。
  if (zoneMinutesOrdered.length >= 2) {
    const totalMin = members.reduce((s, r) => s + (santeiToMinutes(r.santei) ?? 0), 0);
    const totalHours = quantizeHours(totalMin, step, mode);
    const stepsTotal = Math.round((totalHours * 60) / step);
    const alloc = [];
    let used = 0;
    for (let i = 0; i < zoneMinutesOrdered.length; i++) {
      const n = i < zoneMinutesOrdered.length - 1
        ? Math.min(Math.round(zoneMinutesOrdered[i].minutes / step), Math.max(0, stepsTotal - used))
        : Math.max(0, stepsTotal - used);
      used += n;
      alloc.push({ zone: zoneMinutesOrdered[i].zone, hours: n * (step / 60) });
    }
    const nz = alloc.filter((a) => a.hours > 1e-9);
    if (nz.length >= 2) {
      const key = `${kind}|` + nz.map((a) => `${a.zone}${a.hours.toFixed(2)}`).join("・") + `|${mk}`;
      const hit = maps.composite.get(key);
      if (hit) {
        return {
          base: { base: hit.code, name: hit.name, units: hit.units, kind: "composite",
            zone: nz.map((a) => a.zone).join("・"), hours: totalHours, key, twoPerson: false },
          addons: [],
        };
      }
    }
  }
  return resolveBaseAddon(kind, zoneMinutesOrdered, step, mode, maps, false, mk);
}

// ---- ページング ----
async function fetchAll(table, cols, filter) {
  const out = []; const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(table).select(cols).order("id").range(from, from + PAGE - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

// ============================================================================
/**
 * TJ (実績記録票) から **請求対象の提供区間**を読む。
 *
 * ⚠ MEISAI は給与用なので **休憩が含まれる**。
 *   09:00-12:00 + 12:00-13:00(休憩) + 13:00-17:00 = 8.0h
 *   請求できるのは提供時間だけなので TJ は 7.0h。
 *   MEISAI の時刻で段を積むと休憩ぶんまで請求してしまう。
 *   → TJ があるならそちらの区間で段を積む。
 *
 *   TJ の読み方 (docs/TJ_JISSEKI_STRUCTURE.md):
 *     c[7] 受給者証番号 / c[10] **日** (c[9] は提供通番) /
 *     c[15] 開始 HHMM / c[16] 終了 HHMM / c[12] サービスコード (重訪は空)
 *
 * @returns Map<`${受給者証番号}|${日}`, [{s,e}]> 分単位。TJ が無ければ空 Map
 */
function loadTjJuhoSpans(targetMonth, areaDir) {
  const ym = targetMonth.replace("-", "");
  // ⚠ **その拠点の伝送だけ**を読む。伝送データ/ 全体を walk すると、
  //   複数拠点にまたがる利用者の時間が合算されて過大請求になる。
  //   (おゆみ野 鈴木拓也 6/1: おゆみ野 08:00-15:30 に 中央 15:30-21:00 が足され、
  //    段が 日中4.0 までのはずが 夜間16.0 まで生えて 79,885 単位 vs 正 45,200 単位)
  const root = fileURLToPath(new URL(`../伝送データ/${areaDir}/`, import.meta.url));
  const out = new Map();
  let files = [];
  try {
    const walk = (d) => readdirSync(d, { withFileTypes: true })
      .flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    files = walk(root).filter((f) => /TJ\d+\.CSV$/i.test(f) && f.includes(ym));
  } catch { return out; }
  const sp = (l) => l.split(",").map((x) => x.replace(/^"|"$/g, ""));
  const toMin = (v) => {
    const t = String(v ?? "").padStart(4, "0");
    return /^\d{4}$/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(2)) : null;
  };
  for (const f of files) {
    const recs = iconv.decode(readFileSync(f), "Shift_JIS").split(/\r?\n/)
      .filter((l) => l.trim()).map(sp)
      .filter((c) => c[0] === "2" && c[2] === "J611" && c[3] === "02" && !c[12]);
    for (const c of recs) {
      const day = Number(c[10]);
      const s = toMin(c[15]);
      let e = toMin(c[16]);
      if (!c[7] || !Number.isInteger(day) || s == null || e == null) continue;
      // 終了 "0000" は **24:00**。おゆみ野 1221931882 6/5 の 09:00-12:30 + 13:30-0:00 は
      // 算定時間 1400 (= 14.0h) で出ている。
      // ⚠ 五井 1221916057 だけ 16:00-17:00 + 16:00-0:00 が 8.5h で出ており説明がつかない。
      //   1 名だけなので 24:00 を採る (未解決。残件)。
      if (e <= s) e += 1440;                       // 0時またぎ
      // c[20] = 人数。ほのぼのが 2人派遣で請求している提供はここが 2 になる。
      // 稼働データ (MEISAI) は給与用なので人数を確実に持たない。**TJ が正**。
      const n = Number(c[20] || 1) || 1;
      // c[9] = **提供通番**。同じ日でも通番が違えば別のひとまとまり。
      const seq = String(c[9] ?? "");
      // c[11] = **派遣順**。'' = 単独 / '1','2' = 2人派遣の何人目か。
      // ⚠ 2人派遣かどうかは **ここでしか判らない**。時刻の重なりで推測してはいけない
      //   (やわた 宮原和世 6/6 は 13:00-18:30 と 16:30-18:30 が完全に重なるが c[11] は
      //    空で、ほのぼのは 1 人として 7.5h を合算している = 算定時間 0750)。
      const order = String(c[11] ?? "");
      // c[17] = 算定時間。0:00 をまたいで前日から続く分は "0000" (= 前日に算入済み)。
      const calc = String(c[17] ?? "");
      const k = `${c[7]}|${day}`;
      if (!out.has(k)) out.set(k, []);
      out.get(k).push({ s, e, n, seq, order, calc });
    }
  }
  // 算定時間 0 の系列は前日から 0:00 をまたいで続いている分。前日側に算入済みなので落とす。
  //   (五井 1221916057: 6/12 に 16:00-0:00 を出し、6/13 は 0:00-16:00 で算定時間 0000)
  // ⚠ 落とさないと翌日ぶんが丸ごと新しいはしごとして積まれ、深夜1.0〜4.0 や 早朝8.0 の段が
  //   生えて過大請求になる (この人だけで 約 8,000 単位)。
  for (const [k, arr] of out) {
    const carried = new Set(arr.filter((x) => x.calc === "0000").map((x) => x.order));
    const kept = carried.size ? arr.filter((x) => !carried.has(x.order)) : arr;
    kept.sort((a, b) => a.s - b.s);
    if (kept.length) out.set(k, kept);
    else out.delete(k);
  }
  return out;
}

async function main() {
  console.log(`=== MEISAI 障害取込 ${EXECUTE ? "【本番 EXECUTE】" : "【DRY RUN】"} 対象月=${TARGET_MONTH} 事業所=${AREA_DIR} ===\n`);

  // 1) CSV
  const files = findMeisaiFiles(CSV_DIR);
  const all = [];
  for (const f of files) {
    const { idx, rows } = readCsv(f);
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
  // ⚠ **重度訪問介護の内部コードは拠点によって体系が違う**。
  //   やわた・五井 : 021003 (他サービスと同じ 021 系)
  //   おゆみ野・中央・花見川 : **010108〜010270** (サービス名が「重度15％ 8.0」形式)
  //   後者を /^021/ で弾いていたため **重訪が丸ごと取り込まれていなかった**
  //   (おゆみ野 303行11名 / 中央 106行3名 / 花見川 53行1名。
  //    おゆみ野の J121 で「ほのぼのだけ 12名・種類12が114明細」として出ていた)。
  //   → サービス名が「重度」「重訪」で始まる行は 021003 に正規化して取り込む。
  //      (日次通算の juhoByDay が 021003 前提で組まれているため)
  let juhoRenamed = 0;
  for (const r of all) {
    if (/^021/.test(r.code)) continue;
    if (!/^(重度|重訪)/.test(r.svcName ?? "")) continue;
    r._origCode = r.code;
    r.code = "021003";
    juhoRenamed++;
  }
  if (juhoRenamed) {
    console.log(`重訪の内部コード (010xxx) を 021003 に正規化: ${juhoRenamed}行`);
  }
  // ★ MEISAI に **完全重複行**が混じることがある。
  //   (同一ファイル内で 利用者・日付・算定時刻・職員・サービス が全部同じ行が 2 本)
  //   同じヘルパーが同じ時間に 2 回入ることはないので、これは出力側の重複。
  //   放置すると下の 2人派遣 sweep が「時間が重なる = 2人派遣」と誤判定して
  //   ・2人 コードが倍出る。
  //     やわた 野村敦子 1221924572 (2026-06): 40 行が重複し、111112/111196/111216 を
  //     計 40 件 = **16,323 単位の過大請求**になっていた。TJ の派遣順は全 116 行が空で、
  //     ほのぼのは 2人派遣を 1 件も出していない。
  const seenRow = new Set();
  let dupDropped = 0;
  const uniqueRows = [];
  for (const r of all) {
    // ⚠ 時刻が取れない行は対象外。重訪の MEISAI (おゆみ野重度訪問.CSV 等) は列構成が違って
    //   算定時刻を持たず、キーが潰れて **正当な行まで落ちる** (実際に 105 行落ちた)。
    if (!r.santeiStart || !r.santeiEnd) { uniqueRows.push(r); continue; }
    const k = [r.file, r.clientName, r.date, r.santeiStart, r.santeiEnd, r.staffName, r.svcName].join("|");
    if (seenRow.has(k)) { dupDropped++; continue; }
    seenRow.add(k);
    uniqueRows.push(r);
  }
  if (dupDropped) console.log(`⚠ MEISAI の完全重複行を ${dupDropped} 行 落としました (同一ファイル・同じ職員・同じ時刻)`);
  const target = uniqueRows.filter((r) => /^021/.test(r.code));
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
  //   ⚠ **重度訪問介護 (021003) はこの検出から外す**。
  //     重訪は日次通算で「1人目 = 和集合 / 2人目 = 重なり」を自前で積むので、
  //     ここで重なった行を切り出して _twoPerson を立ててしまうと
  //     日次通算に渡る行が減り overlapMin が 0 になって **・2人 が 1 件も出ない**。
  //     実証: おゆみ野 鈴木拓也 — 重なりのある日が 13 日あるのに DB には
  //     1 人目 22 日分しか入らず、ほのぼのの 121272/121282 ×13 が丸ごと欠けていた。
  const byClientDay = new Map();
  for (const r of target) {
    if (r.code === "021003") continue;
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
        // ★ ほのぼのは 2人派遣を **1人目 = 和集合 / 2人目 = 重なり** に組み替えて請求する。
        //   MEISAI は実際に各ヘルパーが入った時刻なので、そのままだと配分が違う。
        //     やわた 前田健司 6/2  MEISAI  07:40-09:10 (1.5h) + 08:40-09:40 (1.0h)
        //                          ほのぼの 07:40-09:40 (2.0h) + 08:40-09:10 (0.5h)
        //     当方は 111367 (早0.5・日1.0) + 111116 (日1.0・2人) を出していたが、
        //     正は 111371 (早0.5・日1.5) + 111112 (日0.5・2人)。6/1・6/9 でも同じ形。
        //   ⚠ 3人以上のブロックは組み替え方が確認できていないので触らない。
        if (members.length === 2) {
          const [first, second] = ordered;
          const uS = Math.min(first.s, second.s), uE = Math.max(first.e, second.e);
          const oS = Math.max(first.s, second.s), oE = Math.min(first.e, second.e);
          if (oE > oS) { setSpan(first.r, uS, uE); setSpan(second.r, oS, oE); }
        }
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

  // 4b-0) 同行援護は障害支援区分でコードが変わるので、氏名 → 区分 の対応を先に作る。
  //   ⚠ 利用者番号は事業者エントリごとに別番号なので**氏名で引く** (受給者証PDFの番号と
  //     MEISAI の番号は一致しない。五井 水越圭彦 = 1000058004 / 2113003002)。
  const kubunByName = new Map();
  {
    const asg = await fetchAll("client_office_assignments", "client_id",
      (q) => q.eq("office_id", OFFICE_ID).order("client_id"));
    const ids = [...new Set(asg.map((a) => a.client_id))];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { data: cls } = await sb.from("clients").select("id,name").in("id", chunk);
      const { data: certs } = await sb.from("shougai_certifications")
        .select("client_id,support_level,certification_start_date,certification_end_date")
        .in("client_id", chunk);
      const nameById = new Map((cls ?? []).map((c) => [c.id, c.name]));
      for (const ce of certs ?? []) {
        // 対象月に有効な証を優先
        const valid = (!ce.certification_start_date || ce.certification_start_date <= `${TARGET_MONTH}-30`)
          && (!ce.certification_end_date || ce.certification_end_date >= `${TARGET_MONTH}-01`);
        const nm = normClientName(nameById.get(ce.client_id) || "");
        if (!nm) continue;
        if (valid || !kubunByName.has(nm)) kubunByName.set(nm, ce.support_level);
      }
    }
    console.log(`障害支援区分マップ: ${kubunByName.size}名`);
  }

  // 4b-0b) 氏名 → 契約 (支給決定) の決定サービスコード集合。
  //   ★ 種別は **市町村の支給決定**が決める。MEISAI のサービス名で決めると
  //     支給決定に無い種別で請求してしまう。
  //       高品 安生美紀子   実績 021001 身体介護(自立)   契約 112000 (家事援助) のみ
  //                         → ほのぼのは 116111 家事日０．５
  //       五井 加藤みのり / 安藤由美子  実績 021007 通院等身体  契約 114000 (通院2) のみ
  //                         → ほのぼのは 117xxx 通院２…
  //   ⚠ client_id の解決はこの時点ではまだなので **氏名で引く** (kubunByName と同じ方式)。
  const decisionsByName = new Map(); // 氏名key -> Set(decision_code)
  {
    const asg = await fetchAll("client_office_assignments", "client_id",
      (q) => q.eq("office_id", OFFICE_ID).order("client_id"));
    const ids = [...new Set(asg.map((a) => a.client_id))];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { data: cls } = await sb.from("clients").select("id,name").in("id", chunk);
      const { data: cons } = await sb.from("shogai_contracts")
        .select("client_id,decision_code,start_date,end_date").in("client_id", chunk);
      const nameById = new Map((cls ?? []).map((c) => [c.id, c.name]));
      for (const c of cons ?? []) {
        // 対象月に有効な契約のみ
        const ok = (!c.start_date || c.start_date <= `${TARGET_MONTH}-31`)
          && (!c.end_date || c.end_date >= `${TARGET_MONTH}-01`);
        if (!ok) continue;
        const nm = normClientName(nameById.get(c.client_id) || "");
        if (!nm || !c.decision_code) continue;
        if (!decisionsByName.has(nm)) decisionsByName.set(nm, new Set());
        decisionsByName.get(nm).add(String(c.decision_code));
      }
    }
    console.log(`契約(支給決定)マップ: ${decisionsByName.size}名`);
  }

  // 実績の種別に対応する決定コードが契約に無く、居宅介護の決定コードが **ちょうど 1 つ**
  // だけあるときは、その種別に寄せる。契約が 0 件 / 2 種類以上のときは触らない。
  {
    const DECISION_OF_KIND = { 身体: "111000", 家事: "112000", 通院1: "113000", 通院2: "114000" };
    const KIND_OF_DECISION = Object.fromEntries(Object.entries(DECISION_OF_KIND).map(([k, v]) => [v, k]));
    const CODE_OF_KIND = { 身体: "021001", 家事: "021002", 通院1: "021007", 通院2: "021006" };
    const fixed = [];
    for (const r of target) {
      const kind = KIND_OF_021[r.code];
      const want = DECISION_OF_KIND[kind];
      if (!want) continue; // 重訪・同行援護は対象外
      const have = decisionsByName.get(normClientName(r.clientName));
      // TRACE_KIND=<氏名の一部> で その人の 契約 vs 実績種別 を 1 行ずつ出す
      if (process.env.TRACE_KIND && (r.clientName || "").includes(process.env.TRACE_KIND)) {
        console.log(`[kind] "${r.clientName}" key="${normClientName(r.clientName)}" code=${r.code} `
          + `kind=${kind} want=${want} have=${have ? [...have].join(",") : "なし"}`);
      }
      if (!have || have.has(want)) continue;
      const kyotaku = [...have].filter((d) => KIND_OF_DECISION[d]);
      if (kyotaku.length !== 1) continue;
      const to = CODE_OF_KIND[KIND_OF_DECISION[kyotaku[0]]];
      if (!to || to === r.code) continue;
      fixed.push(`${normClientName(r.clientName)} ${kind}→${KIND_OF_DECISION[kyotaku[0]]} (契約 ${kyotaku[0]})`);
      r.code = to;
    }
    if (fixed.length) {
      const uniq = [...new Set(fixed)];
      console.log(`⚠ 契約に無い種別を支給決定に寄せました: ${fixed.length}行 / ${uniq.length}名`);
      for (const f of uniq) console.log(`    ${f}`);
    }
  }

  // 4b) map をロードして変換
  const maps = await loadCodeMaps();
  console.log(`コード map: single=${maps.single.size} single2=${maps.single2.size} composite=${maps.composite.size} composite2=${maps.composite2.size} increment=${maps.increment.size} increment2=${maps.increment2.size} (居宅介護 身体/家事 + 同行援護 基本)`);
  console.log(`2人派遣ブロック: ${twoPersonVisits} 件 (・2人 行 ${secondRows} = 2人目以降を全て請求計上)\n`);
  const rowConv = []; // target と同じ index。各要素: null | { minutes, convs:[conv,...] } | { skip: true } (合算セッションの2件目以降)
  const convWarn = [];
  const missKeys = new Set();
  let blockedNoDur = 0, blocked6 = 0, compositeCount = 0, twoPersonCount = 0, fellBackCount = 0, addonCount = 0;
  const sessionResultCache = new Map(); // members(配列参照) -> {conv結果 or null}

  // ── 重度訪問介護 (021003) は日次通算 ──
  //   制度上「1日の所要時間を通算して算定」するため、行ごとではなく **利用者×日** で
  //   まとめて段を解決する。同一日に時間帯が重なる訪問は 2 人派遣なので、
  //   1人目 = 和集合(union)の時間 / 2人目 = 重なった時間 として別々に積む。
  //   結果はその日の**先頭行**にだけ載せ、残りの行は skip する (二重計上防止)。
  //
  //   ⚠ 集約キーに **利用者番号を使ってはいけない**。ほのぼのは 2 人派遣の 2 人目を
  //     「〇〇（2人目」という**別利用者**として登録することがあり、番号が別になる
  //     (おゆみ野 鈴木拓也 = 1000059089 と 2113112579)。番号でまとめると別人扱いになり
  //     重なりが検出されず **・2人 が 1 件も出ない**。
  //     → 氏名 (末尾の「（2人目」等を落として正規化) + 日付 でまとめる。
  const juhoConvByRow = new Map(); // target の row 参照 -> { convs:[...] }
  const juhoSkip = new Set();
  // TJ の請求対象区間を 日|最初の開始|最後の終了 で引けるようにする。
  // 同じキーに複数人が当たる場合は曖昧なので捨てる (MEISAI に倒す)。
  let tjUsedDays = 0, tjMissDays = 0;
  const tjMissNames = new Set();
  const tjHaveNames = new Set();
  const tjPeople = new Set();   // TJ に重訪がある利用者 (氏名key)
  let tjSkipDays = 0;
  const tjSkipNames = new Set();
  const tjByDaySpan = new Map();     // `${氏名key}|${日}` → [{s,e}]  ★氏名で引く
  const tjByEnvelope = new Map();    // `${日}|${最初の開始}|${最後の終了}` → [{s,e}]  (保険)
  {
    const spansByJukyuDay = loadTjJuhoSpans(TARGET_MONTH, AREA_DIR);

    // ★ TJ は受給者証番号で持っている。**氏名に直して引く**。
    //   以前は「日 + 最初の開始 + 最後の終了」で突き合わせていたが、
    //   休憩が日の端に来る日・複数セッションの日は外枠がズレて当たらず、
    //   おゆみ野 158 日中 55 日しか救えていなかった。
    //   受給者証番号なら 1 対 1 で確実に引ける。
    const nameByBeneficiary = new Map();
    {
      const asg = await fetchAll("client_office_assignments", "client_id",
        (q) => q.eq("office_id", OFFICE_ID).order("client_id"));
      const ids = [...new Set(asg.map((a) => a.client_id))];
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        const { data: cls, error: eC } = await sb.from("clients").select("id,name").in("id", chunk);
        if (eC) { console.error(`✗ clients 取得失敗: ${eC.message}`); process.exit(1); }
        const { data: cts, error: eT } = await sb.from("shougai_certifications")
          .select("client_id,beneficiary_number").in("client_id", chunk);
        if (eT) { console.error(`✗ 受給者証取得失敗: ${eT.message}`); process.exit(1); }
        const nameById = new Map((cls ?? []).map((c) => [c.id, c.name]));
        for (const ct of cts ?? []) {
          const nm = nameById.get(ct.client_id);
          if (ct.beneficiary_number && nm) nameByBeneficiary.set(String(ct.beneficiary_number), nm);
        }
      }
    }

    const nameKey = (n) => (n || "").normalize("NFKC").replace(/[（(].*$/, "").replace(/[\s　]/g, "");
    const seen = new Map();
    let named = 0;
    for (const [k, arr] of spansByJukyuDay) {
      if (!arr.length) continue;
      const [ben, dayStr] = k.split("|");
      const day = Number(dayStr);
      const nm = nameByBeneficiary.get(ben);
      if (nm) {
        tjByDaySpan.set(`${nameKey(nm)}|${day}`, arr); named++;
        tjHaveNames.add(nameKey(nm));
        tjPeople.add(nameKey(nm));      // この人は TJ が正
      } else tjHaveNames.add(`?${ben}`);
      const key = `${day}|${Math.min(...arr.map((x) => x.s))}|${Math.max(...arr.map((x) => x.e))}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      tjByEnvelope.set(key, arr);
    }
    for (const [key, n] of seen) if (n > 1) tjByEnvelope.delete(key);
    if (spansByJukyuDay.size) {
      console.log(`TJ 実績記録票: ${spansByJukyuDay.size} (受給者×日) 読込 / ` +
        `氏名で引けるもの ${named} / 時刻の外枠で引けるもの ${tjByEnvelope.size}`);
    }
  }
  {
    // 「鈴木　拓也（2人目」→「鈴木拓也」。括弧以降と空白を落とす
    const juhoNameKey = (n) =>
      (n || "").normalize("NFKC").replace(/[（(].*$/, "").replace(/[\s　]/g, "");
    // MEISAI の氏名末尾に付く制度の目印 (障=障害 / 支=支援 等) を落とした候補も試す。
    // 一致した名前を返す。どれも当たらなければ undefined。
    const tjNameCandidates = (name) => {
      const base = juhoNameKey(name);
      return [base, base.replace(/[障支介総]$/, "")].filter(Boolean);
    };
    const tjLookup = (name, day) => {
      for (const k of tjNameCandidates(name)) {
        const hit = tjByDaySpan.get(`${k}|${day}`);
        if (hit?.length) return hit;
      }
      return undefined;
    };
    const byUserDay = new Map();
    for (const r of target) {
      if (r.code !== "021003") continue;
      const k = `${juhoNameKey(r.clientName)}|${r.date}`;
      if (!byUserDay.has(k)) byUserDay.set(k, []);
      byUserDay.get(k).push(r);
    }
    if (SKIP_JUHO && byUserDay.size) {
      console.log(`重訪 ${byUserDay.size} (利用者×日) は **TJ から入れる**のでスキップ ` +
        `(--skip-juho)。import_juho_from_tj.mjs を実行すること`);
    }
    for (const rows of (SKIP_JUHO ? [] : byUserDay.values())) {
      // ⚠ 終了が開始以前の行は **0 時またぎ** (17:00-00:00 の夜勤)。24 時間足して 1 本にする。
      //   ここで落とすと withTime.length !== rows.length になり、下の「時刻が取れる」判定を
      //   外れて **算定時間の単純合計**に倒れる。合計だけでは時間帯が判らないので
      //   段が全部 日中 で出る (おゆみ野 稲葉裕子 6/5・12・19・26 が実際にそうなっていた。
      //   ほのぼのは 夜間12.0×7 / 深夜16.0×3 等を出している)。
      const withTime = rows
        .map((r) => {
          const s = parseHM(r.santeiStart);
          let e = parseHM(r.santeiEnd);
          if (s != null && e != null && e <= s) e += 1440;
          return { r, s, e };
        })
        .filter((x) => x.s != null && x.e != null && x.e > x.s)
        .sort((a, b) => a.s - b.s);
      // 時間が取れない行は従来どおり算定時間の単純合計に倒す
      const totalMin = rows.reduce((sum, r) => sum + (santeiToMinutes(r.santei) ?? 0), 0);
      let convs = [];
      let minutes = 0;
      if (withTime.length === rows.length && withTime.length > 0) {
        // ★ 時刻が取れる = 確定ルールで時間帯ぶんかつ段を解決する。
        //   重なっても **合算する** (2人派遣にしない)。
        const stepsByZone = {};
        const stepsByZone2 = {};
        for (const [z, label] of [["早", "早朝"], ["日", "日中"], ["夜", "夜間"], ["深", "深夜"]]) {
          stepsByZone[z] = juhoStepsFor(maps, label, false);
          stepsByZone2[z] = juhoStepsFor(maps, label, true);
        }
        if (!Object.values(stepsByZone).some(Boolean)) {
          convWarn.push(`重訪 段テーブル無し (${rows[0].clientName} ${rows[0].date})`);
          missKeys.add("重訪II|全時間帯|1人");
          continue;
        }
        // ★ TJ (実績記録票) にその日の **請求対象区間**があるならそちらを使う。
        //   MEISAI は給与用なので休憩が含まれる。MEISAI の時刻で段を積むと
        //   休憩ぶんまで請求してしまう (おゆみ野だけで 213 時間ぶん)。
        //
        //   TJ 側は受給者証番号で持っているが、この時点では client_id 解決が
        //   まだなので **日 + 最初の開始 + 最後の終了**で突き合わせる。
        //   ⚠ 開始時刻の集合では一致しない。休憩ぶん MEISAI のほうが行数が多いため
        //     (MEISAI 09:00/12:00/13:00 に対し TJ は 09:00/13:00)。
        //   ⚠ 同じキーに複数人が当たる日は **曖昧なので使わない** (MEISAI に倒す)。
        //   TJ が無い月・拠点も従来どおり MEISAI の時刻で積む。
        const day = Number(String(rows[0].date).slice(-2));
        const minS = Math.min(...withTime.map((x) => x.s));
        const maxE = Math.max(...withTime.map((x) => (x.e <= x.s ? x.e + 1440 : x.e)));
        // ★ 氏名で引く。引けないときだけ従来の外枠キーに落とす。
        //   ⚠ MEISAI の氏名は **制度の目印が末尾に付く**ことがある
        //     (「宇野純一障」「中島保人支」)。素の氏名も候補にする。
        const tjSpans = tjLookup(rows[0].clientName, day)
          ?? tjByEnvelope.get(`${day}|${minS}|${maxE}`);
        // ★ その人に TJ (実績記録票) があるなら **TJ が正**。
        //   稼働データにあって TJ に無い日は ほのぼのが請求していない日なので
        //   計上しない。落とさないと段が丸ごと増えて過大請求になる。
        //   (おゆみ野 鈴木拓也: 稼働 26 日 / TJ 22 日。差の 4 日ぶんで
        //    夜間の段まで生えて 79,885 単位 vs 正 45,200 単位 になっていた)
        if (!tjSpans?.length && tjPeople.has(tjNameCandidates(rows[0].clientName).find((k) => tjPeople.has(k)) ?? "")) {
          tjSkipDays++; tjSkipNames.add(juhoNameKey(rows[0].clientName));
          for (const r of rows) juhoSkip.add(r);
          continue;
        }
        if (tjSpans?.length) tjUsedDays++;
        else { tjMissDays++; tjMissNames.add(`${juhoNameKey(rows[0].clientName)}`); }
        // TRACE_JUHO=<氏名の一部> でその人の全日を 1 行ずつ出す (TJ が引けたかの確認用)
        if (process.env.TRACE_JUHO && juhoNameKey(rows[0].clientName).includes(process.env.TRACE_JUHO)) {
          console.log(`[trace] ${rows[0].date} tj=${tjSpans?.length ?? 0} meisai=${withTime.length} ` +
            `spans=${(tjSpans ?? withTime).map((x) => `${x.s}-${x.e}`).join(" ")}`);
        }
        const spans = tjSpans?.length
          ? tjSpans
          : withTime.map((x) => ({ s: x.s, e: x.e }));
        // ★ 重訪の 1 日は **原則ひとつの通算**。制度上「1日の所要時間を通算して算定」する。
        //   系列を分けるのは **TJ の派遣順 c[11] が '1'/'2' のときだけ**。
        //   '' は単独なので、同じ日の '' どうしは全部つないで 1 本のはしごにする。
        //
        //     やわた 宮原和世 6/6   13:00-18:30 と 16:30-18:30 (完全に重なる) / c[11] 空
        //       → **1 人**として 7.5h を合算 (算定時間 0750)。2人派遣ではない
        //     おゆみ野 2000038857   c[11]='1' 09:00-17:30 / c[11]='2' 14:30-15:30
        //       → 2 人派遣。2人目は 121272 (・２人) で 1 段だけ
        //
        //   ⚠ 以前は「提供通番が時間的に重なる = 2人派遣」と推測していたが、これは誤り。
        //     重なりは 1 人が中抜けして戻った日にも起きる。判定材料は c[11] だけ。
        //   ⚠ 系列ごとに必ず積み直すと、単独の日で 1.0/1.5/2.0/2.5 の段が人数ぶん増えて
        //     **倍額**になる (五井 1221916057 で 891,543 円 vs 正 492,680 円)。
        //   TJ が無くて MEISAI の時刻に倒したときは派遣順が無いので 1 本で積む。
        const resolved = (() => {
          const byOrder = new Map();
          for (const sp of spans) {
            const k = sp.order ?? "";
            if (!byOrder.has(k)) byOrder.set(k, []);
            byOrder.get(k).push(sp);
          }
          if (byOrder.size <= 1) return juhoConvsForDay(spans, stepsByZone, stepsByZone2);
          const out = [];
          for (const [k, g] of [...byOrder.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
            const two = k === "2";
            const r = juhoConvsForDay(
              g.map((x) => ({ ...x, n: two ? 2 : 1 })).sort((a, b) => a.s - b.s),
              stepsByZone, stepsByZone2);
            if (r) out.push(...r);
          }
          return out.length ? out : null;
        })();
                if (process.env.DEBUG_JUHO && juhoNameKey(rows[0].clientName).includes(process.env.DEBUG_JUHO)
            && rows[0].date === (process.env.DEBUG_DAY ?? "2026-06-01")) {
          console.log(`
[debug] ${rows[0].clientName} ${rows[0].date}`);
          console.log(`  MEISAI 行 ${rows.length}  withTime ${withTime.length}`);
          console.log(`  spans: ${spans.map((x) => `${x.seq ?? "-"}:${x.s}-${x.e}`).join(" ")}`);
          console.log(`  結果: ${(resolved ?? []).map((r) => r.name).join(" / ")}`);
        }
        if (!resolved) continue;
        convs = resolved.map((st) => ({
          base: st.code, name: st.name, units: st.units, kind: "juho",
          zone: st.zone, twoPerson: !!st.two,
        }));
        minutes = withTime.reduce((sum, x) => sum + (x.e - x.s), 0);
      } else {
        // 時刻が欠けている行がある場合だけ、従来の単一時間帯 fallback
        const zoneLabel = zoneDigit(rows[0].santeiStart).zone;
        const steps = juhoStepsFor(maps, zoneLabel, false);
        if (!steps) {
          convWarn.push(`重訪 段テーブル無し zone=${zoneLabel} (${rows[0].clientName} ${rows[0].date})`);
          missKeys.add(`重訪II|${zoneLabel}|1人`);
          continue;
        }
        convs = juhoStepsForMinutes(steps, totalMin, mode).map((st) => ({
          base: st.code, name: st.name, units: st.units, kind: "juho",
          zone: zoneLabel, twoPerson: false,
        }));
        minutes = totalMin;
      }
      if (convs.length === 0) continue;
      juhoConvByRow.set(rows[0], { minutes, convs });
      for (const r of rows.slice(1)) juhoSkip.add(r);
    }
    if (tjSkipDays) {
      console.log(`  TJ に無い日を落とした: ${tjSkipDays} 日 (${[...tjSkipNames].join(" / ")})`);
    }
    if (tjMissNames.size) {
      console.log(`  TJ で引けなかった利用者: ${[...tjMissNames].join(" / ")}`);
      console.log(`  TJ 側に居る受給者: ${[...tjHaveNames].join(" / ")}`);
    }
    if (byUserDay.size) console.log(`重訪 日次通算: ${byUserDay.size} (利用者×日) → ${juhoConvByRow.size} 日分に集約` +
      (tjUsedDays + tjMissDays > 0 ? ` (TJ の請求区間を使用 ${tjUsedDays} / MEISAI の時刻 ${tjMissDays})` : ""));
  }

  for (const r of target) {
    if (r.code === "021003") {
      if (juhoSkip.has(r)) { rowConv.push({ skip: true }); continue; }
      rowConv.push(juhoConvByRow.get(r) ?? null);
      if (!juhoConvByRow.has(r)) blocked6++;
      continue;
    }
    const session = sessionOf.get(r);
    if (session) {
      // 合算セッションの代表行 = session[0] (buildDailySessions で開始時刻昇順に格納済)。
      // 代表行以外は payload を出さない (二重計上防止。base+addon は代表行の1回だけ生成)。
      if (r !== session[0]) { rowConv.push({ skip: true }); continue; }
      if (!sessionResultCache.has(session)) sessionResultCache.set(session, convertSession(session, mode, maps,
        (() => { const k = DOUKOU_CODES.has(session[0].code)
          ? doukouKubunMod(kubunByName.get(normClientName(session[0].clientName))) : null;
          return k ? [k] : []; })()));
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
    const kubun = DOUKOU_CODES.has(r.code)
      ? doukouKubunMod(kubunByName.get(normClientName(r.clientName)))
      : null;
    const conv = convertRow(r.code, minutes, r.santeiStart, r.santeiEnd, mode, maps, r._twoPerson, kubun ? [kubun] : []);
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
  const clients = await fetchAll("clients", "id,name,user_number");
  const clientByUserNumber = new Map();
  for (const c of clients) {
    const k = String(c.user_number ?? "");
    if (!k) continue;
    if (!clientByUserNumber.has(k)) clientByUserNumber.set(k, []);
    clientByUserNumber.get(k).push(c.id);
  }
  const clientByName = new Map();
  for (const c of clients) { const k = normClientName(c.name); if (!clientByName.has(k)) clientByName.set(k, []); clientByName.get(k).push(c.id); }
  const nameByNum = {}; for (const r of target) nameByNum[r.clientNum] = r.clientName;

  const resolvedClient = new Map(); // clientNum -> client_id
  const unresolvedClients = [];
  for (const num of uniqNums) {
    if (numToClient[num]) { resolvedClient.set(num, numToClient[num]); continue; }
    const nm = normClientName(nameByNum[num]);
    const hits = clientByName.get(nm) || [];
    if (hits.length === 1) { resolvedClient.set(num, hits[0]); continue; }
    // 受給者証一覧表 (PDF) は**氏名を 17 文字程度で切る**ので、長い氏名は完全一致しない
    //   (中央 「BAT ERDENE BATBAYAR」→ PDF は「BAT ERDENE BATBAY」)。
    //   一方が他方の先頭部分になっていて、かつ 10 文字以上 (日本人名は正規化後 4〜6 文字
    //   なので誤結合しない長さ) なら同一人物とみなす。
    if (hits.length === 0 && nm.length >= 10) {
      const pre = [...clientByName.entries()].filter(
        ([k, v]) => v.length === 1 && k.length >= 10 && (nm.startsWith(k) || k.startsWith(nm)),
      );
      if (pre.length === 1) {
        console.log(`  ↔ ${num} ${nameByNum[num]}: 氏名が途中で切れた受給者証と一致 "${pre[0][0]}"`);
        resolvedClient.set(num, pre[0][1][0]);
        continue;
      }
    }
    // 稼働データ側の氏名が **カナ**のことがある (MEISAI「齊藤　ﾕｳｷ」/ 受給者証「齊藤 優希」)。
    //   氏名では引けないので **利用者番号** で引き直す。番号は事業者エントリ単位で
    //   一意なので、DB 側に同じ user_number が 1 件だけならそれで確定してよい。
    if (hits.length === 0) {
      const byNum = clientByUserNumber.get(String(num)) || [];
      if (byNum.length === 1) {
        console.log(`  ↔ ${num} ${nameByNum[num]}: 氏名で引けず利用者番号で解決 (カナ表記等)`);
        resolvedClient.set(num, byNum[0]);
        continue;
      }
    }
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
  let blockedNoClient = 0, sessionSkipped = 0, recordOnlyRows = 0;
  const payloads = [];
  for (let i = 0; i < target.length; i++) {
    const r = target[i]; const rc = rowConv[i];
    if (!rc) continue; // 変換不可(算定時間/6桁未解決)は 4) で計上済み
    if (rc.skip) {
      // 合算セッションの2件目以降。請求は代表行に合算済みだが、実績記録票 (J611) には
      //   ほのぼの同様「提供時刻ごとの行」を出す必要があるので、**記録専用行**として残す。
      //   notes に [合算従属] を付け、aggregate 側で集計から除外する
      //   (service_type は代表と同じ = 記録票の内容コードが引けるようにするため)。
      sessionSkipped++;
      const cid0 = resolvedClient.get(r.clientNum);
      const repIdx = target.indexOf(sessionOf.get(r)?.[0]);
      const repName = repIdx >= 0 ? rowConv[repIdx]?.convs?.[0]?.name : null;
      if (cid0 && repName) {
        const sid = (memberByName.get(normStaff(r.staffName)) || []).length === 1
          ? memberByName.get(normStaff(r.staffName))[0] : null;
        payloads.push({
          user_id: cid0, staff_id: sid, visit_date: r.date,
          start_time: r.start || r.santeiStart || null,
          end_time: r.end || r.santeiEnd || null,
          service_type: repName,
          // 制度区分。この script が走った時点で「障害」と確定する (推測しない)。
          system: "障害",
          status: "completed", office_id: office.id, tenant_id: TENANT_ID,
          notes: `[MEISAI障害取込 ${TARGET_MONTH} ${MAP_TAG} ${MARK_SESSION_SUB} code=${r.code}]`,
        });
        recordOnlyRows++;
      }
      continue;
    }
    const cid = resolvedClient.get(r.clientNum);
    if (!cid) { blockedNoClient++; continue; }

    // 合算セッションの代表行も **自分の実提供時刻のまま** 残す。
    //   請求 (単位数) はセッション合計で解決した代表行の convs が持ち、2件目以降は
    //   上の記録専用行として実時刻で出す。以前はここでメンバー全体のスパン
    //   (例 14:00-20:00) に潰していたが、中断 (間に別区分の提供が挟まる) が消えて
    //   実績記録票の提供時刻・算定時間合計がほのぼのと食い違っていた。
    const startTime = r.start || null;
    const endTime = r.end || null;
    const staffId = (memberByName.get(normStaff(r.staffName)) || []).length === 1
      ? memberByName.get(normStaff(r.staffName))[0]
      : null;

    // convs[0] = 基本コード / convs[1..] = 増(加算)コード。
    //   増は請求上の単位でしかなく実際の訪問ではないため、実績記録票 (J611) には出さない。
    //   → notes に MARK_ADDON を付け、記録票側のローダーで除外する (集計側は含める)。
    for (let ci = 0; ci < rc.convs.length; ci++) {
      const c = rc.convs[ci];
      payloads.push({
        user_id: cid,
        staff_id: staffId,
        visit_date: r.date,
        start_time: startTime,
        end_time: endTime,
        service_type: c.name, // 障害マスタ名(公式6桁) 完全一致 (aggregate が名前で拾う)
        // 制度区分。この script が走った時点で「障害」と確定する (推測しない)。
        // ⚠ 入れないと取込のたびに system が消える。
        system: "障害",
        status: "completed",
        office_id: office.id,
        tenant_id: TENANT_ID,
        notes: `[MEISAI障害取込 ${TARGET_MONTH} ${MAP_TAG}${ci > 0 ? ` ${MARK_ADDON}` : ""} code=${c.base}]`,
      });
    }
  }
  // 2人派遣は 4a で 長い方=基本 / 短い方=・2人 として全行残す (畳まない)。ここでの再 dedup は不要。
  const deduped = payloads;

  console.log(`=== 取込可否サマリ (障害021 ${target.length}行) ===`);
  console.log(`  取込可能(=INSERT行): ${deduped.length}`);
  console.log(`  2人派遣: ${twoPersonVisits}件 (・2人 行 ${twoPersonCount} を基本行と別に計上=2倍請求)`);
  console.log(`  合算セッション: ${mergedSessionCount}件 (対象${mergedRowCount}行 → 請求は代表行に集約。2件目以降 ${sessionSkipped}行は記録専用行として ${recordOnlyRows} 行 INSERT)`);
  console.log(`  増addon行: ${addonCount}`);
  console.log(`  ブロック(利用者未解決): ${blockedNoClient}`);
  console.log(`  ブロック(6桁コード未解決): ${blocked6}`);
  console.log(`  ブロック(算定時間不正): ${blockedNoDur}`);
  if (deduped[0]) console.log("\nINSERT payload サンプル:\n", JSON.stringify(deduped[0], null, 2));
  console.log("");

  if (!EXECUTE) { console.log("※ DRY RUN のため INSERT していません。--execute で本番投入。"); return; }

  // ── ★ 削除の前に FK を検証する ────────────────────────────────────────
  //   このスクリプトは「削除 → INSERT」の順なので、INSERT が落ちると
  //   **削除だけ実行されてデータが消えたまま**になる。
  //   2026-08-30 に花見川で実際に起きた: 名寄せ (_meisai_num_to_client_花見川.json)
  //   の client_id が重複統合で消えていて (414000166 村上泉)、FK 違反で 0 件 INSERT。
  //   → 参照先が実在することを **削除前に**確かめる。
  {
    const userIds = [...new Set(deduped.map((r) => r.user_id).filter(Boolean))];
    const staffIds = [...new Set(deduped.map((r) => r.staff_id).filter(Boolean))];
    const checkExists = async (table, ids) => {
      const found = new Set();
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await sb.from(table).select("id").in("id", ids.slice(i, i + 200));
        if (error) { console.error(`✗ ${table} 検証失敗: ${error.message}`); process.exit(1); }
        for (const r of data) found.add(r.id);
      }
      return ids.filter((id) => !found.has(id));
    };
    const missUsers = await checkExists("clients", userIds);
    const missStaff = await checkExists("members", staffIds);
    if (missUsers.length || missStaff.length) {
      console.error("\n✗ 参照先が存在しないため **何も削除せずに中止**しました");
      if (missUsers.length) {
        console.error(`  clients に無い user_id ${missUsers.length} 件:`);
        for (const id of missUsers.slice(0, 10)) {
          const num = Object.entries(numToClient ?? {}).find(([, v]) => v === id)?.[0];
          console.error(`    ${id}${num ? `  (名寄せ ${MAP_TAG}: 利用者番号 ${num})` : ""}`);
        }
        console.error(`  → migrations/_meisai_num_to_client_${MAP_TAG}.json の client_id が` +
          ` 重複統合などで消えている可能性。現行の clients.id に張り替えること`);
      }
      if (missStaff.length) {
        console.error(`  members に無い staff_id ${missStaff.length} 件: ${missStaff.slice(0, 5).join(", ")}`);
      }
      process.exit(1);
    }
    console.log(`FK 検証 OK (利用者 ${userIds.length} / 職員 ${staffIds.length})`);
  }

  // 冪等: 既存の障害取込行を削除。
  // ⚠ **必ず対象月に絞る**。月スコープを忘れると翌月を取り込んだ瞬間に前月が全消しになる
  //   (2026-08-07 に介護側で実際に起きた)。
  const [dy, dm] = TARGET_MONTH.split("-").map(Number);
  const MONTH_LAST = `${TARGET_MONTH}-${String(new Date(dy, dm, 0).getDate()).padStart(2, "0")}`;
  const { error: delErr } = await sb.from("kaigo_visit_schedule").delete()
    .eq("office_id", office.id).like("notes", "[MEISAI障害取込%")
    .gte("visit_date", MONTH_FIRST).lte("visit_date", MONTH_LAST);
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
