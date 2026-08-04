/**
 * ほのぼの実伝送を正として、DB の「負担割合」「公費 (法別・負担者番号・受給者番号)」の
 * 誤りを全拠点まとめて検出する。**READ ONLY (DRY RUN 専用・--execute は無い)**。
 *
 * 背景 (2026-08-04 の 202606 突合):
 *   - 負担割合が 1割固定になっている利用者がいる (保険請求の過大計上)
 *   - 公費負担者番号の先頭2桁 (法別番号) が 12 に化けている (法別81 が伝送に出ない)
 *
 * 突合元: 伝送データ/<拠点>/<事業種別>/<提供年月>/ほのぼのから/*.CSV の
 *   7131/01 (介護給付 明細書 基本情報) と 71R1/01 (総合事業 明細書 基本情報)
 *   項7  = 公費1 負担者番号
 *   項8  = 公費1 受給者番号
 *   項29 = 保険給付率 (90/80/70)
 * 突合先: clients(insured_number) → client_insurance_records / client_kohi_records
 *
 * 実行: node migrations/detect_kohi_futan_mismatch.mjs
 *   env: MONTH=202606 (既定。伝送フォルダの提供年月で絞る)
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Encoding from "encoding-japanese";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = join(__dirname, "..");
const ROOT = join(APP, "伝送データ");
const MONTH = process.env.MONTH || "202606";

function loadEnvLocal() {
  const raw = readFileSync(join(APP, ".env.local"), "utf8");
  const vars = {};
  for (const line of raw.split("\n")) {
    const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
    if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return vars;
}
const env = loadEnvLocal();
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("env 不足: .env.local の SUPABASE URL / SERVICE_ROLE_KEY が必要");
  process.exit(1);
}
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
function splitCsvLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}
const t = (s) => (s ?? "").trim();

// ─── 1) ほのぼの側の「正」を集める ────────────────────────────────────────────
// key = 被保険者番号。同じ人が複数拠点に出ることがあるので、値が食い違ったら記録する。
const truth = new Map(); // insured -> { rate:Set, futansha:Set, jukyusha:Set, files:Set, insurer:Set }
const files = walk(ROOT).filter(
  (f) => /ほのぼのから/.test(f) && /\.csv$/i.test(f) && f.includes(MONTH),
);
for (const f of files) {
  const text = Encoding.codeToString(
    Encoding.convert(new Uint8Array(readFileSync(f)), { to: "UNICODE", from: "SJIS" }),
  );
  for (const line of text.split(/\r\n|\n/)) {
    if (!line) continue;
    const c = splitCsvLine(line);
    if (c[0] !== "2") continue;
    const id = c[2];
    if (!((id === "7131" || id === "71R1") && c[3] === "01")) continue;
    const insured = t(c[7]);
    if (!insured) continue;
    if (!truth.has(insured)) {
      truth.set(insured, {
        rate: new Set(), futansha: new Set(), jukyusha: new Set(),
        insurer: new Set(), files: new Set(),
      });
    }
    const e = truth.get(insured);
    e.insurer.add(t(c[6]));
    if (t(c[30])) e.rate.add(t(c[30])); // 項29 保険給付率
    if (t(c[8])) e.futansha.add(t(c[8])); // 項7 公費1 負担者番号
    if (t(c[9])) e.jukyusha.add(t(c[9])); // 項8 公費1 受給者番号
    e.files.add(f.split("伝送データ")[1].replace(/\\/g, "/"));
  }
}
console.log(`ほのぼの側: ${files.length} ファイル / 被保険者 ${truth.size} 名 (提供年月 ${MONTH})\n`);

// ─── 2) DB 側 ────────────────────────────────────────────────────────────────
const insuredList = [...truth.keys()];
const clients = [];
for (let i = 0; i < insuredList.length; i += 100) {
  const { data, error } = await sb
    .from("clients")
    .select("id, name, insured_number")
    .in("insured_number", insuredList.slice(i, i + 100));
  if (error) { console.error("clients 取得失敗:", error.message); process.exit(1); }
  clients.push(...(data ?? []));
}
const byInsured = new Map();
for (const c of clients) {
  if (!byInsured.has(c.insured_number)) byInsured.set(c.insured_number, []);
  byInsured.get(c.insured_number).push(c);
}
const clientIds = clients.map((c) => c.id);

const insRows = [];
for (let i = 0; i < clientIds.length; i += 100) {
  const { data, error } = await sb
    .from("client_insurance_records")
    .select("client_id, insured_number, benefit_rate, copay_rate, certification_start_date, certification_end_date")
    .in("client_id", clientIds.slice(i, i + 100));
  if (error) { console.error("認定取得失敗:", error.message); process.exit(1); }
  insRows.push(...(data ?? []));
}
const insByClient = new Map();
for (const r of insRows) {
  if (!insByClient.has(r.client_id)) insByClient.set(r.client_id, []);
  insByClient.get(r.client_id).push(r);
}

const kohiRows = [];
for (let i = 0; i < clientIds.length; i += 100) {
  const { data, error } = await sb
    .from("client_kohi_records")
    .select("id, client_id, kohi_hobetsu, futansha_number, jukyusha_number, start_date, end_date, priority, honnin_futan, notes")
    .in("client_id", clientIds.slice(i, i + 100));
  if (error) { console.error("公費取得失敗:", error.message); process.exit(1); }
  kohiRows.push(...(data ?? []));
}
const kohiByClient = new Map();
for (const r of kohiRows) {
  if (!kohiByClient.has(r.client_id)) kohiByClient.set(r.client_id, []);
  kohiByClient.get(r.client_id).push(r);
}

// 対象月に有効な行だけを見る
const mStart = `${MONTH.slice(0, 4)}-${MONTH.slice(4)}-01`;
const mEnd = `${MONTH.slice(0, 4)}-${MONTH.slice(4)}-31`;
const activeIn = (r) =>
  (!r.start_date || r.start_date <= mEnd) && (!r.end_date || r.end_date >= mStart);

// ─── 3) 突合 ─────────────────────────────────────────────────────────────────
const COPAY_BY_RATE = { "90": "1", "80": "2", "70": "3" };
const RATE_BY_COPAY = { "1": "90", "2": "80", "3": "70" };
const rateMismatch = [], futanshaMismatch = [], kohiMissing = [], noClient = [], ambiguous = [], noActiveCert = [], benefitRateStale = [];

for (const [insured, e] of truth) {
  const cs = byInsured.get(insured);
  if (!cs || cs.length === 0) { noClient.push(insured); continue; }
  if (cs.length > 1) ambiguous.push(`${insured} → clients ${cs.length}件`);
  const c = cs[0];

  // 給付率
  // ⚠ 請求ロジック (aggregate.ts) が見ているのは copay_rate (1/2/3 割) であって
  //    benefit_rate ではない。benefit_rate は 90 固定のまま放置されている行が多く、
  //    そちらで突合すると偽陽性だらけになる。判定は copay_rate で行い、
  //    benefit_rate のズレは「参考」として別枠に出す。
  if (e.rate.size === 1) {
    const hbRate = [...e.rate][0]; // 90 / 80 / 70
    const hbCopay = COPAY_BY_RATE[hbRate]; // "1" / "2" / "3"
    const act = (insByClient.get(c.id) ?? []).filter((r) =>
      activeIn({ start_date: r.certification_start_date, end_date: r.certification_end_date }));
    if (act.length === 0) {
      noActiveCert.push({ insured, name: c.name, hb: hbRate, files: [...e.files][0] });
    } else if (hbCopay) {
      const dbCopays = new Set(act.map((r) => String(r.copay_rate ?? "")).filter(Boolean));
      if (dbCopays.size > 0 && !dbCopays.has(hbCopay)) {
        rateMismatch.push({
          insured, name: c.name, hb: hbRate, hbCopay,
          db: [...dbCopays].join("/"), files: [...e.files][0],
        });
      }
      // 参考: benefit_rate が copay_rate と食い違っている行 (請求には影響しない)
      for (const r of act) {
        const br = String(r.benefit_rate ?? "");
        const expected = RATE_BY_COPAY[String(r.copay_rate ?? "")];
        if (br && expected && br !== expected)
          benefitRateStale.push({ insured, name: c.name, copay_rate: r.copay_rate, benefit_rate: br });
      }
    }
  }

  // 公費 負担者番号
  if (e.futansha.size >= 1) {
    const hbNums = [...e.futansha];
    const dbActive = (kohiByClient.get(c.id) ?? []).filter(activeIn);
    const dbNums = new Set(dbActive.map((r) => t(r.futansha_number)));
    for (const hb of hbNums) {
      if (dbNums.has(hb)) continue;
      // 下 8 桁 (法別を除く) が一致するものがあれば「法別だけ違う」
      const same = [...dbNums].find((d) => d.slice(2) === hb.slice(2) && d.slice(0, 2) !== hb.slice(0, 2));
      if (same) {
        futanshaMismatch.push({
          insured, name: c.name, hb, db: same,
          hbHobetsu: hb.slice(0, 2), dbHobetsu: same.slice(0, 2),
          dbRowIds: dbActive.filter((r) => t(r.futansha_number) === same).map((r) => r.id),
          notes: dbActive.filter((r) => t(r.futansha_number) === same).map((r) => r.notes).join(" / "),
        });
      } else {
        kohiMissing.push({ insured, name: c.name, hb, db: [...dbNums].join("/") || "(DBに公費なし)" });
      }
    }
  }
}

// ─── 4) レポート ─────────────────────────────────────────────────────────────
const line = (s) => console.log(s);
line("========== 🔴 負担割合 (copay_rate) の不一致 = 請求額に直結 ==========");
line(`${rateMismatch.length} 件`);
for (const r of rateMismatch)
  line(`  ${r.insured} ${r.name}: ほのぼの給付率=${r.hb} (=${r.hbCopay}割) / DB copay_rate=${r.db}   ${r.files}`);

line("\n========== 🔴 公費負担者番号 法別の化け (下8桁は一致) ==========");
line(`${futanshaMismatch.length} 件`);
for (const r of futanshaMismatch)
  line(`  ${r.insured} ${r.name}: ほのぼの=${r.hb} (法別${r.hbHobetsu}) / DB=${r.db} (法別${r.dbHobetsu})  notes="${r.notes}"`);

line("\n========== 🟠 DB に無い / 全く違う公費 ==========");
line(`${kohiMissing.length} 件`);
for (const r of kohiMissing.slice(0, 40))
  line(`  ${r.insured} ${r.name}: ほのぼの=${r.hb} / DB=${r.db}`);
if (kohiMissing.length > 40) line(`  … 他 ${kohiMissing.length - 40} 件`);

line("\n========== 参考 ==========");
line(`clients に居ない被保険者番号: ${noClient.length} 件`);
if (noClient.length) line(`  ${noClient.slice(0, 20).join(", ")}${noClient.length > 20 ? " …" : ""}`);
line(`被保険者番号が複数 clients に紐づく: ${ambiguous.length} 件`);
for (const a of ambiguous.slice(0, 10)) line(`  ${a}`);

const outPath = join(__dirname, `_detect_kohi_futan_${MONTH}.json`);
writeFileSync(outPath, JSON.stringify({ rateMismatch, futanshaMismatch, kohiMissing, noActiveCert, benefitRateStale, noClient, ambiguous }, null, 1));
line(`\n詳細 JSON: ${outPath}`);
line("\n※ この script は検出のみ。修正は結果を確認してから別 script で行うこと。");
