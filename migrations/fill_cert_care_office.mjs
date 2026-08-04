/**
 * import_cert_history.mjs で挿入した認定行に、居宅介護支援事業所 (care_office_number /
 * care_office_id) を補う。**READ ONLY で始まり --execute で UPDATE**。
 *
 * 背景: 介護保険1.CSV には「支援事業所（正式名称）」はあるが**事業所番号が無い**。
 *   番号が空だと 7131/71R1 の項19「居宅サービス計画作成区分」が 2 (自己作成)・
 *   項20 が空欄で出てしまう (認定履歴を入れた直後に大網3件・姉ム6件が発生した)。
 *
 * 補い方: 同じ利用者の他の認定行が持っている care_office_number / care_office_id を
 *   引き継ぐ。**null の行だけ**埋め、既に値がある行は触らない。
 *   同じ利用者で複数の番号が使われている場合は「認定開始日が最も近い行」の値を使う。
 *
 * 実行:
 *   node migrations/fill_cert_care_office.mjs            # DRY RUN
 *   node migrations/fill_cert_care_office.mjs --execute
 *   env: MARK=... (既定 "[認定履歴取込 2026-08-04]" の行だけを対象にする)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = join(__dirname, "..");
const EXECUTE = process.argv.includes("--execute");
const MARK = process.env.MARK || "[認定履歴取込 2026-08-04]";

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

// 対象 = MARK の行で care_office_number が null のもの
const targets = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb
    .from("client_insurance_records")
    .select("id, client_id, certification_start_date, care_office_number, care_office_id, notes")
    .eq("notes", MARK)
    .is("care_office_id", null)
    .order("id")
    .range(from, from + 999);
  if (error) { console.error("取得失敗:", error.message); process.exit(1); }
  if (!data || data.length === 0) break;
  targets.push(...data);
  if (data.length < 1000) break;
}
console.log(`対象 (${MARK} / care_office_id が null): ${targets.length} 行`);
if (targets.length === 0) process.exit(0);

// 同じ利用者の他の行 (番号を持つもの)
const clientIds = [...new Set(targets.map((t) => t.client_id))];
const donors = new Map(); // client_id -> [{start, number, id}]
for (let i = 0; i < clientIds.length; i += 100) {
  const { data, error } = await sb
    .from("client_insurance_records")
    .select("client_id, certification_start_date, care_office_number, care_office_id")
    .in("client_id", clientIds.slice(i, i + 100))
    .not("care_office_id", "is", null);
  if (error) { console.error("参照行の取得失敗:", error.message); process.exit(1); }
  for (const r of data ?? []) {
    if (!donors.has(r.client_id)) donors.set(r.client_id, []);
    donors.get(r.client_id).push(r);
  }
}

const days = (a, b) => Math.abs(new Date(a).getTime() - new Date(b).getTime());
const plan = [], noDonor = [];
for (const t of targets) {
  const ds = donors.get(t.client_id);
  if (!ds || ds.length === 0) { noDonor.push(t.client_id); continue; }
  // 認定開始日が最も近い行の値を使う
  const best = ds.slice().sort(
    (a, b) => days(a.certification_start_date ?? "1900-01-01", t.certification_start_date) -
              days(b.certification_start_date ?? "1900-01-01", t.certification_start_date),
  )[0];
  plan.push({
    id: t.id, clientId: t.client_id, start: t.certification_start_date,
    number: best.care_office_number, officeId: best.care_office_id,
    from: best.certification_start_date,
    multi: new Set(ds.map((d) => d.care_office_id)).size > 1,
  });
}
const multi = plan.filter((p) => p.multi).length;
console.log(`${EXECUTE ? "🔴 本番実行" : "DRY RUN"}`);
console.log(`  補える: ${plan.length} 行 (うち利用者内で複数の事業所番号があるもの ${multi} 行)`);
console.log(`  参照元が無い (この利用者はどの行にも居宅事業所なし): ${new Set(noDonor).size} 名 / ${noDonor.length} 行`);
for (const p of plan.slice(0, 10))
  console.log(`    ${p.start} ← ${p.officeId} / 番号${p.number ?? "(id解決)"} (${p.from} の行から)${p.multi ? " ★複数事業所あり" : ""}`);
if (plan.length > 10) console.log(`    … 他 ${plan.length - 10} 行`);

if (!EXECUTE) {
  console.log("\nDRY RUN — 何も書き換えていません。--execute で UPDATE します。");
  process.exit(0);
}

let ok = 0;
for (const p of plan) {
  const { error } = await sb
    .from("client_insurance_records")
    .update({ care_office_number: p.number, care_office_id: p.officeId })
    .eq("id", p.id);
  if (error) { console.error(`  ✗ ${p.id}: ${error.message}`); continue; }
  ok++;
}
const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const outPath = join(__dirname, `_fill_cert_care_office_${stamp}.json`);
writeFileSync(outPath, JSON.stringify(plan, null, 1));
console.log(`\n完了: ${ok}/${plan.length} 行 UPDATE`);
console.log(`変更内容: ${outPath}`);
