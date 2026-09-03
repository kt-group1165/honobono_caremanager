/**
 * seed_teigen_test_office.mjs / verify_teigen_logic.mts で作成した
 * 逓減制検証用テストデータを完全に削除する。
 *
 * 対象:
 *   - kaigo_care_support_claims (notes LIKE '%[fake テスト用-teigen-20260903]%')
 *   - client_kohi_records       (notes = marker)
 *   - client_insurance_records  (notes = marker)
 *   - kaigo_care_plans          (user_id が対象 client)
 *   - client_office_assignments (office_id = テスト事業所)
 *   - client_memos              (body LIKE marker)
 *   - clients                   (user_number 900001〜900069 かつ tenant_id=kt-group)
 *   - offices                   (business_number = 9999999901)
 *
 * Usage:
 *   node migrations/delete_teigen_test_office.mjs              # DRY RUN (件数のみ)
 *   node migrations/delete_teigen_test_office.mjs --execute    # 本番実行
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadEnvFile(path) {
  try {
    const env = readFileSync(path, "utf8");
    const vars = {};
    for (const line of env.split("\n")) {
      const m = line.match(/^([^=]+)=(.+)$/);
      if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return vars;
  } catch {
    return {};
  }
}
const envKaigo = loadEnvFile(join(__dirname, "..", ".env.local"));
const SB_URL = envKaigo.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = envKaigo.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("SUPABASE URL / SERVICE_ROLE_KEY が読めません (.env.local 確認)");
  process.exit(1);
}
const sb = createClient(SB_URL, SB_KEY);

const TENANT_ID = "kt-group";
const MARKER = "[fake テスト用-teigen-20260903]";
const TEST_OFFICE_BUSINESS_NUMBER = "9999999901";
const EXECUTE = process.argv.includes("--execute");

async function fetchAll(table, select, filters = {}, likeFilters = {}) {
  const all = [];
  let from = 0;
  while (true) {
    let q = sb.from(table).select(select).range(from, from + 999);
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    for (const [k, v] of Object.entries(likeFilters)) q = q.like(k, v);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

async function main() {
  console.log(`\n🗑  逓減制検証 テストデータ削除`);
  console.log(EXECUTE ? "⚠️  EXECUTE MODE (実削除)" : "🔍 DRY RUN (件数のみ)");
  console.log(`marker = ${MARKER}\n`);

  const officeRows = await fetchAll("offices", "id, name", { business_number: TEST_OFFICE_BUSINESS_NUMBER });
  const officeId = officeRows[0]?.id ?? null;
  console.log(`テスト office: ${officeId ? `${officeId} (${officeRows[0].name})` : "(見つからず = 既に削除済み)"}`);

  const clientRows = await fetchAll("clients", "id, user_number", { tenant_id: TENANT_ID });
  const testClientIds = clientRows
    .filter((c) => {
      const n = Number(c.user_number);
      return Number.isFinite(n) && n >= 900001 && n <= 900069;
    })
    .map((c) => c.id);
  console.log(`テスト clients: ${testClientIds.length} 名`);

  const claims = await fetchAll("kaigo_care_support_claims", "id", {}, { notes: `%${MARKER}%` });
  console.log(`kaigo_care_support_claims (marker一致): ${claims.length} 件`);

  const kohi = await fetchAll("client_kohi_records", "id", {}, { notes: `%${MARKER}%` });
  console.log(`client_kohi_records (marker一致): ${kohi.length} 件`);

  const insurance = await fetchAll("client_insurance_records", "id", {}, { notes: `%${MARKER}%` });
  console.log(`client_insurance_records (marker一致): ${insurance.length} 件`);

  const memos = await fetchAll("client_memos", "id", {}, { body: `%${MARKER}%` });
  console.log(`client_memos (marker一致): ${memos.length} 件`);

  let plans = [];
  let assigns = [];
  if (testClientIds.length > 0) {
    // in() は 50件ずつ chunk
    for (let i = 0; i < testClientIds.length; i += 50) {
      const chunk = testClientIds.slice(i, i + 50);
      const { data: p } = await sb.from("kaigo_care_plans").select("id").in("user_id", chunk);
      plans.push(...(p ?? []));
      const { data: a } = await sb.from("client_office_assignments").select("id").in("client_id", chunk);
      assigns.push(...(a ?? []));
    }
  }
  console.log(`kaigo_care_plans (対象client): ${plans.length} 件`);
  console.log(`client_office_assignments (対象client): ${assigns.length} 件`);

  if (!EXECUTE) {
    console.log("\n✅ DRY RUN 完了。--execute を付けて再実行で本番削除。");
    return;
  }

  console.log("\n削除実行中...");

  if (claims.length > 0) {
    const { error } = await sb.from("kaigo_care_support_claims").delete().like("notes", `%${MARKER}%`);
    if (error) console.warn(`⚠️ kaigo_care_support_claims: ${error.message}`);
    else console.log(`✓ kaigo_care_support_claims 削除`);
  }
  if (kohi.length > 0) {
    const { error } = await sb.from("client_kohi_records").delete().like("notes", `%${MARKER}%`);
    if (error) console.warn(`⚠️ client_kohi_records: ${error.message}`);
    else console.log(`✓ client_kohi_records 削除`);
  }
  if (insurance.length > 0) {
    const { error } = await sb.from("client_insurance_records").delete().like("notes", `%${MARKER}%`);
    if (error) console.warn(`⚠️ client_insurance_records: ${error.message}`);
    else console.log(`✓ client_insurance_records 削除`);
  }
  if (memos.length > 0) {
    const { error } = await sb.from("client_memos").delete().like("body", `%${MARKER}%`);
    if (error) console.warn(`⚠️ client_memos: ${error.message}`);
    else console.log(`✓ client_memos 削除`);
  }
  for (let i = 0; i < testClientIds.length; i += 50) {
    const chunk = testClientIds.slice(i, i + 50);
    const { error: e1 } = await sb.from("kaigo_care_plans").delete().in("user_id", chunk);
    if (e1) console.warn(`⚠️ kaigo_care_plans chunk ${i}: ${e1.message}`);
    const { error: e2 } = await sb.from("client_office_assignments").delete().in("client_id", chunk);
    if (e2) console.warn(`⚠️ client_office_assignments chunk ${i}: ${e2.message}`);
  }
  console.log(`✓ kaigo_care_plans / client_office_assignments 削除`);

  if (testClientIds.length > 0) {
    for (let i = 0; i < testClientIds.length; i += 50) {
      const chunk = testClientIds.slice(i, i + 50);
      const { error } = await sb.from("clients").delete().in("id", chunk);
      if (error) console.warn(`⚠️ clients chunk ${i}: ${error.message}`);
    }
    console.log(`✓ clients 削除 (${testClientIds.length} 名)`);
  }

  if (officeId) {
    const { error } = await sb.from("offices").delete().eq("id", officeId);
    if (error) console.warn(`⚠️ offices: ${error.message}`);
    else console.log(`✓ offices 削除 (${officeId})`);
  }

  console.log("\n✅ 削除完了");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
