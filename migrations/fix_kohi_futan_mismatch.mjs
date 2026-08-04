/**
 * detect_kohi_futan_mismatch.mjs が出した誤りを是正する。
 *
 * 対象 (ほのぼの実伝送を正とする):
 *   1) 保険給付率 (負担割合) — client_insurance_records.benefit_rate / copay_rate
 *      DB が 90 (1割) 固定なのに実際は 80 (2割) / 70 (3割) の利用者
 *   2) 公費負担者番号の法別 — client_kohi_records.futansha_number / kohi_hobetsu
 *      下 8 桁は一致するのに先頭 2 桁 (法別番号) だけ違うもの
 *
 * 実行:
 *   node migrations/detect_kohi_futan_mismatch.mjs        # 先にこれで検出
 *   node migrations/fix_kohi_futan_mismatch.mjs           # DRY RUN (既定)
 *   node migrations/fix_kohi_futan_mismatch.mjs --execute # 本番
 *
 *   env: MONTH=202606 (検出 JSON の年月)
 *
 * --execute 時は書き換え前の行を _backup_kohi_futan_<MONTH>_<日付>.json に保存する。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = join(__dirname, "..");
const MONTH = process.env.MONTH || "202606";
const EXECUTE = process.argv.includes("--execute");

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
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const detectPath = join(__dirname, `_detect_kohi_futan_${MONTH}.json`);
if (!existsSync(detectPath)) {
  console.error(`検出結果がありません: ${detectPath}`);
  console.error("先に node migrations/detect_kohi_futan_mismatch.mjs を実行してください");
  process.exit(1);
}
const det = JSON.parse(readFileSync(detectPath, "utf8"));

console.log(`${EXECUTE ? "🔴 本番実行" : "DRY RUN"} — 対象月 ${MONTH}\n`);

// 給付率 90 → 実際の割合。copay_rate は 1/2/3 割の数値。
const COPAY_BY_RATE = { "90": "1", "80": "2", "70": "3" };

const mStart = `${MONTH.slice(0, 4)}-${MONTH.slice(4)}-01`;
const mEnd = `${MONTH.slice(0, 4)}-${MONTH.slice(4)}-31`;

const backup = { insurance: [], kohi: [] };
const plan = { insurance: [], kohi: [] };

// ─── 1) 給付率 ───────────────────────────────────────────────────────────────
const insuredNumbers = [...new Set(det.rateMismatch.map((r) => r.insured))];
const clientByInsured = new Map();
for (let i = 0; i < insuredNumbers.length; i += 100) {
  const { data, error } = await sb
    .from("clients").select("id, name, insured_number")
    .in("insured_number", insuredNumbers.slice(i, i + 100));
  if (error) { console.error("clients 取得失敗:", error.message); process.exit(1); }
  for (const c of data ?? []) clientByInsured.set(c.insured_number, c);
}
for (const r of det.rateMismatch) {
  const c = clientByInsured.get(r.insured);
  if (!c) { console.log(`  ⚠ ${r.insured} ${r.name}: clients に見つからず skip`); continue; }
  const { data, error } = await sb
    .from("client_insurance_records")
    .select("id, benefit_rate, copay_rate, certification_start_date, certification_end_date")
    .eq("client_id", c.id);
  if (error) { console.error("認定取得失敗:", error.message); process.exit(1); }
  const active = (data ?? []).filter(
    (x) => (!x.certification_start_date || x.certification_start_date <= mEnd) &&
           (!x.certification_end_date || x.certification_end_date >= mStart),
  );
  if (active.length === 0) { console.log(`  ⚠ ${r.insured} ${r.name}: 対象月に有効な認定なし skip`); continue; }
  const copay = COPAY_BY_RATE[r.hb];
  if (!copay) { console.log(`  ⚠ ${r.insured} ${r.name}: 想定外の給付率 ${r.hb} skip`); continue; }
  for (const row of active) {
    // 請求ロジックが見るのは copay_rate。benefit_rate も整合させておく。
    if (String(row.copay_rate ?? "") === copay && String(row.benefit_rate ?? "") === r.hb) continue;
    backup.insurance.push(row);
    plan.insurance.push({
      id: row.id, insured: r.insured, name: r.name,
      before: { benefit_rate: row.benefit_rate, copay_rate: row.copay_rate },
      after: { benefit_rate: r.hb, copay_rate: copay },
    });
  }
}

// ─── 2) 公費 法別 ────────────────────────────────────────────────────────────
for (const r of det.futanshaMismatch) {
  for (const id of r.dbRowIds ?? []) {
    const { data, error } = await sb
      .from("client_kohi_records").select("*").eq("id", id).maybeSingle();
    if (error) { console.error("公費取得失敗:", error.message); process.exit(1); }
    if (!data) continue;
    backup.kohi.push(data);
    plan.kohi.push({
      id, insured: r.insured, name: r.name,
      before: { futansha_number: data.futansha_number, kohi_hobetsu: data.kohi_hobetsu },
      after: { futansha_number: r.hb, kohi_hobetsu: r.hb.slice(0, 2) },
    });
  }
}

// ─── 3) 表示 ─────────────────────────────────────────────────────────────────
console.log(`=== 1) 負担割合 (copay_rate) ${plan.insurance.length} 行 ===`);
for (const p of plan.insurance)
  console.log(`  ${p.insured} ${p.name}: benefit_rate ${p.before.benefit_rate}→${p.after.benefit_rate} / copay_rate ${p.before.copay_rate}→${p.after.copay_rate}`);
console.log(`\n=== 2) 公費 法別 ${plan.kohi.length} 行 ===`);
for (const p of plan.kohi)
  console.log(`  ${p.insured} ${p.name}: futansha_number ${p.before.futansha_number}→${p.after.futansha_number} / hobetsu ${p.before.kohi_hobetsu}→${p.after.kohi_hobetsu}`);

if (!EXECUTE) {
  console.log("\nDRY RUN — 何も書き換えていません。--execute で反映します。");
  process.exit(0);
}

// ─── 4) 実行 ─────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const bkPath = join(__dirname, `_backup_kohi_futan_${MONTH}_${stamp}.json`);
writeFileSync(bkPath, JSON.stringify(backup, null, 1));
console.log(`\nバックアップ: ${bkPath}`);

let okIns = 0, okKohi = 0;
for (const p of plan.insurance) {
  const { error } = await sb
    .from("client_insurance_records")
    .update({ benefit_rate: p.after.benefit_rate, copay_rate: p.after.copay_rate })
    .eq("id", p.id);
  if (error) { console.error(`  ✗ ${p.insured} ${p.name}: ${error.message}`); continue; }
  okIns++;
}
for (const p of plan.kohi) {
  const { error } = await sb
    .from("client_kohi_records")
    .update({ futansha_number: p.after.futansha_number, kohi_hobetsu: p.after.kohi_hobetsu })
    .eq("id", p.id);
  if (error) { console.error(`  ✗ ${p.insured} ${p.name}: ${error.message}`); continue; }
  okKohi++;
}
console.log(`\n完了: 給付率 ${okIns}/${plan.insurance.length} 行 / 公費 ${okKohi}/${plan.kohi.length} 行`);
console.log("反映後は伝送突合ハーネスを回し直して 0 差になることを確認してください。");
