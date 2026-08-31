#!/usr/bin/env node
// 重度訪問介護 の 段積み上げルールを TJ(実績記録票) から再現し、KJ(J121 請求明細) と突合する。
// read-only。DB は書き換えない。
//
//   node scripts/tj-juho-analyze.mjs              全 17 拠点
//   AREA=やわた node scripts/tj-juho-analyze.mjs  1 拠点
//   DETAIL=1    受給者ごとの内訳も出す
import fs from "node:fs";
import path from "node:path";
import iconv from "iconv-lite";

const ROOT = path.join(process.cwd(), "伝送データ");
const MONTH = process.env.MONTH || "202606";

// ---- 段の定義 (告示) ---------------------------------------------------
// 累計 t (0.5h 刻み) → コードが表す「時間」。4.0h 超は刻み境界のコードを繰り返す。
function stepCodeTime(t) {
  if (t <= 4.0) return t; // 1.0〜4.0 は個別コード
  if (t <= 8.0) return 8.0;
  if (t === 8.5) return 8.5;
  if (t <= 12.0) return 12.0;
  if (t === 12.5) return 12.5;
  if (t <= 16.0) return 16.0;
  if (t === 16.5) return 16.5;
  if (t <= 20.0) return 20.0;
  if (t === 20.5) return 20.5;
  return 24.0;
}

// ---- 時間帯 ------------------------------------------------------------
// 早朝 6-8 / 日中 8-18 / 夜間 18-22 / 深夜 22-6
function zoneOf(hour) {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 8 && h < 18) return "日中";
  if (h >= 18 && h < 22) return "夜間";
  if (h >= 6 && h < 8) return "早朝";
  return "深夜";
}
// 終了時刻 "0000" は **24:00**。おゆみ野 1221931882 6/5 の 09:00-12:30 + 13:30-0:00 は
// 算定時間 1400 (= 14.0h) で出ている。
// ⚠ 五井 1221916057 だけ 16:00-17:00 + 16:00-0:00 が 8.5h で出ていて説明がつかない (残件)。
const hhmm = (s) => Number(s.slice(0, 2)) + Number(s.slice(2, 4)) / 60;

// ---- CSV ---------------------------------------------------------------
function readCsv(file) {
  const text = iconv.decode(fs.readFileSync(file), "cp932");
  return text
    .split(/\r?\n/)
    .filter((l) => l.length)
    .map((l) => l.split(",").map((c) => c.replace(/^"|"$/g, "")));
}

// ---- 1 日ぶんの提供列 → 段の列挙 --------------------------------------
// 系列 (= 1 人のヘルパー) ごとに、TJ の行順に通算して段を積む。
// 同じ系列の中は時刻が重なっていても単純合算する (2人派遣とは見なさない)。
function stepsForSeries(provisions, persons) {
  const out = [];
  let cum = 0;
  for (const p of provisions) {
    let dur = p.end - p.start;
    if (dur < 0) dur += 24; // 日跨ぎ
    if (dur <= 0) continue;
    const after = cum + dur;
    // 段 t = 0.5 刻み。区間 (t-0.5, t] が 1 段。
    for (let t = Math.floor(cum * 2) / 2 + 0.5; t <= after + 1e-9; t += 0.5) {
      const tt = Number(t.toFixed(1));
      if (tt < 1.0 - 1e-9) continue; // 1.0 未満の段は存在しない
      if (tt <= cum + 1e-9) continue;
      const offset = Math.max(0, tt - 0.5 - cum); // 段の開始が提供内のどこか
      out.push({ time: stepCodeTime(tt), zone: zoneOf(p.start + offset), persons });
    }
    cum = after;
  }
  return out;
}

// TJ の 派遣順 列 (c11) が系列を決める。
//   ''        単独。同じ日の '' 行どうしは 1 系列に合算する
//   '1' / '2' 2人派遣。1人目 = 素の段 / 2人目 = ・２人 の段。系列を分けて別々に積む
function stepsForDay(provisions) {
  const series = new Map();
  for (const p of provisions) {
    const k = p.order || "";
    if (!series.has(k)) series.set(k, []);
    series.get(k).push(p);
  }
  const out = [];
  for (const [k, ps] of series) out.push(...stepsForSeries(ps, k === "2" ? 2 : 1));
  return out;
}

// ---- マスタ ------------------------------------------------------------
const Z2H = (s) =>
  s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/．/g, ".");

async function loadMaster() {
  const SB = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const K = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB || !K) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が無い");
  const y = MONTH.slice(0, 4);
  const m = MONTH.slice(4, 6);
  // PostgREST は 1 回 1000 行までしか返さない。重訪だけで 2,800 件あるので必ずページングする
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const url =
      `${SB}/rest/v1/kaigo_service_codes?select=service_code,service_name,units&service_category=eq.12` +
      `&valid_from=lte.${y}-${m}-01&or=(valid_until.is.null,valid_until.gte.${y}-${m}-28)` +
      `&order=service_code&offset=${offset}&limit=1000`;
    const res = await fetch(url, { headers: { apikey: K, Authorization: `Bearer ${K}` } });
    const page = await res.json();
    if (!Array.isArray(page)) throw new Error("マスタ取得失敗: " + JSON.stringify(page));
    rows.push(...page);
    if (page.length < 1000) break;
  }
  const byKey = new Map(); // 区分|時間帯|時間|人数 -> code
  const byCode = new Map(); // code -> {rank,zone,time,persons,units,name}
  for (const r of rows) {
    // 「重訪Ⅱ日中８．０」/「重訪Ⅱ夜間８．５・２人」/「重訪Ⅰ入院等日中１．０」
    // 入院等 は段の積み方が同じで単価だけ違う (= 入院中の重訪)。段の検証では素の段に畳む。
    const mm = /^重訪(Ⅰ|Ⅱ|Ⅲ)?(入院等)?(日中|夜間|深夜|早朝)([０-９．]+)(・２人)?$/.exec(r.service_name);
    if (!mm) continue;
    const rank = mm[1] || "-";
    const variant = mm[2] ? "入院等" : "素";
    const zone = mm[3];
    const time = Number(Z2H(mm[4]));
    const persons = mm[5] ? 2 : 1;
    if (variant === "素") byKey.set(`${rank}|${zone}|${time}|${persons}`, r.service_code);
    byCode.set(r.service_code, { rank, variant, zone, time, persons, units: r.units, name: r.service_name });
  }
  return { byKey, byCode };
}

// ---- 拠点 --------------------------------------------------------------
function findAreas() {
  const areas = [];
  for (const area of fs.readdirSync(ROOT)) {
    const base = path.join(ROOT, area, "訪問介護", "障害", MONTH);
    if (!fs.existsSync(base)) continue;
    for (const sub of fs.readdirSync(base)) {
      const dir = path.join(base, sub);
      if (!fs.statSync(dir).isDirectory()) continue;
      const files = fs.readdirSync(dir);
      const tj = files.find((f) => /^TJ.*\.CSV$/i.test(f) && !/解説/.test(f));
      const kj = files.find((f) => /^KJ.*\.CSV$/i.test(f) && !/解説/.test(f));
      if (tj && kj) areas.push({ area, sub, tj: path.join(dir, tj), kj: path.join(dir, kj) });
    }
  }
  return areas;
}

const master = await loadMaster();
const only = process.env.AREA;
const detail = !!process.env.DETAIL;
const totals = { areas: 0, users: 0, ok: 0, ng: 0, personsTwo: 0, unmapped: new Set() };
const allDiffs = [];

for (const a of findAreas()) {
  if (only && a.area !== only) continue;

  // --- TJ: 重訪 (サービスコード列が空) の提供を 受給者証 × 日 で集める
  const tj = readCsv(a.tj).filter((r) => r[0] === "2" && r[2] === "J611" && r[3] === "02");
  const days = new Map(); // 証|日 -> [provision]
  for (const r of tj) {
    if (r[12] !== "") continue; // 重訪はサービスコード列が空
    if (!r[15] || !r[16]) continue;
    const key = `${r[7]}|${String(r[10]).padStart(2, "0")}`;
    if (!days.has(key)) days.set(key, []);
    days.get(key).push({ start: hhmm(r[15]), end: hhmm(r[16]), order: r[11], calc: r[17], persons: Number(r[20] || "1") });
  }
  if (!days.size) continue;

  // --- KJ: J121 明細 03 の重訪コード実測
  const kj = readCsv(a.kj).filter((r) => r[0] === "2" && r[2] === "J121" && r[3] === "03");
  // 段そのものを検証したいので 素 / 入院等 は同じキーに畳む
  const actual = new Map(); // 証 -> Map(zone|time|persons -> count)
  const nyuin = new Map(); // 証 -> 入院等 の段数
  for (const r of kj) {
    const code = r[8];
    const info = master.byCode.get(code);
    if (!info) {
      if (/^12/.test(code)) totals.unmapped.add(code);
      continue;
    }
    if (!actual.has(r[7])) actual.set(r[7], new Map());
    const m = actual.get(r[7]);
    const k = `${info.zone}|${info.time}|${info.persons}`;
    const n = Number(r[10] || 0);
    m.set(k, (m.get(k) || 0) + n);
    if (info.variant === "入院等") nyuin.set(r[7], (nyuin.get(r[7]) || 0) + n);
  }

  // --- 受給者ごとに再現して突合
  const users = new Map(); // 証 -> Map(zone|time|persons -> count)
  for (const [key, provisions] of days) {
    const cert = key.split("|")[0];
    if (!users.has(cert)) users.set(cert, new Map());
    const exp = users.get(cert);
    for (const s of stepsForDay(provisions)) {
      if (s.persons === 2) totals.personsTwo++;
      const k = `${s.zone}|${s.time}|${s.persons}`;
      exp.set(k, (exp.get(k) || 0) + 1);
    }
  }

  totals.areas++;
  for (const [cert, exp] of users) {
    totals.users++;
    const act = actual.get(cert) || new Map();
    const keys = new Set([...exp.keys(), ...act.keys()]);
    const diffs = [];
    for (const k of [...keys].sort()) {
      const e = exp.get(k) || 0;
      const v = act.get(k) || 0;
      if (e === v) continue;
      const [zone, time, persons] = k.split("|");
      // 単位数は表示用。区分が判らないケースもあるので Ⅱ を代表に使う
      const rep = master.byCode.get(master.byKey.get(`Ⅱ|${zone}|${time}|${persons}`));
      diffs.push({ label: `${zone}${time}${persons === "2" ? "・2人" : ""}`, exp: e, act: v, units: rep?.units || 0 });
    }
    if (!diffs.length) {
      totals.ok++;
      if (detail) console.log(`  ✓ ${a.area} ${cert}${nyuin.get(cert) ? ` (うち入院等 ${nyuin.get(cert)}段)` : ""}`);
    } else {
      totals.ng++;
      allDiffs.push({ area: a.area, cert, diffs });
    }
  }
}

console.log(`=== 重訪 段積み上げ 再現テスト (${MONTH}) ===`);
console.log(`拠点 ${totals.areas} / 受給者 ${totals.users} → 一致 ${totals.ok} / 不一致 ${totals.ng}`);
console.log(`TJ の 人数=2 の重訪段: ${totals.personsTwo}`);
if (totals.unmapped.size) console.log(`マスタに無い 12xxxx コード: ${[...totals.unmapped].join(", ")}`);
for (const d of allDiffs) {
  console.log(`\n★ ${d.area} 受給者証 ${d.cert}`);
  for (const x of d.diffs) {
    const u = (x.exp - x.act) * x.units;
    console.log(
      `   ${x.label.padEnd(14)} 期待${String(x.exp).padStart(4)} 実測${String(x.act).padStart(4)}  差${String(x.exp - x.act).padStart(4)} (${u > 0 ? "+" : ""}${u}単位)`,
    );
  }
}
