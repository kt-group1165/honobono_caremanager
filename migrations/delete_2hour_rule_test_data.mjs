// ============================================================================
// seed_2hour_rule_test_data.mjs で作った「2時間ルール」検証用テストデータを
// すべて削除する。本番データには一切触れない (対象は全て固定 ID / fake office 配下)。
//
//   使い方:
//     node migrations/delete_2hour_rule_test_data.mjs              # DRY RUN (件数確認のみ)
//     node migrations/delete_2hour_rule_test_data.mjs --execute    # 本番削除
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const OFFICE_ID = "383a296f-f6b3-4088-bf67-c5d274d78a62";
const CLIENT_ID = "a6495a94-9442-4128-b55c-8fcf17eefa79";
const STAFF_NAMES = ["検証職員A", "検証職員B"];
const AREA_DIR = "_2時間ルール検証テスト";

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
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function main() {
  console.log(`=== 2時間ルール検証データ 削除 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const { data: staff } = await sb.from("members").select("id,name").in("name", STAFF_NAMES);
  const staffIds = (staff ?? []).map((m) => m.id);

  const plan = [
    { label: "kaigo_visit_schedule (office_id)", table: "kaigo_visit_schedule", col: "office_id", val: OFFICE_ID },
    { label: "member_offices (office_id)", table: "member_offices", col: "office_id", val: OFFICE_ID },
    { label: "shogai_contracts (client_id)", table: "shogai_contracts", col: "client_id", val: CLIENT_ID },
    { label: "shougai_certifications (client_id)", table: "shougai_certifications", col: "client_id", val: CLIENT_ID },
    { label: "client_kohi_records (client_id)", table: "client_kohi_records", col: "client_id", val: CLIENT_ID },
    { label: "client_office_assignments (client_id)", table: "client_office_assignments", col: "client_id", val: CLIENT_ID },
  ];

  for (const p of plan) {
    const { count, error } = await sb.from(p.table).select("*", { count: "exact", head: true }).eq(p.col, p.val);
    if (error) { console.error(`✗ ${p.label} 件数取得失敗: ${error.message}`); process.exit(1); }
    console.log(`${p.label}: ${count} 件`);
  }
  {
    const { count } = await sb.from("clients").select("*", { count: "exact", head: true }).eq("id", CLIENT_ID);
    console.log(`clients (id): ${count} 件`);
  }
  {
    const { count } = await sb.from("members").select("*", { count: "exact", head: true }).in("name", STAFF_NAMES);
    console.log(`members (name): ${count} 件`);
  }
  {
    const { count } = await sb.from("offices").select("*", { count: "exact", head: true }).eq("id", OFFICE_ID);
    console.log(`offices (id): ${count} 件`);
  }
  const csvDir = fileURLToPath(new URL(`../サービス実績データ/${AREA_DIR}/`, import.meta.url));
  console.log(`CSV フォルダ: ${csvDir} (存在=${existsSync(csvDir)})`);

  if (!EXECUTE) {
    console.log("\n※ DRY RUN のため削除していません。--execute で本番削除。");
    return;
  }

  for (const p of plan) {
    const { error } = await sb.from(p.table).delete().eq(p.col, p.val);
    if (error) { console.error(`✗ ${p.label} 削除失敗: ${error.message}`); process.exit(1); }
    console.log(`✓ ${p.label} 削除`);
  }
  {
    const { error } = await sb.from("clients").delete().eq("id", CLIENT_ID);
    if (error) { console.error(`✗ clients 削除失敗: ${error.message}`); process.exit(1); }
    console.log("✓ clients 削除");
  }
  if (staffIds.length) {
    const { error } = await sb.from("members").delete().in("id", staffIds);
    if (error) { console.error(`✗ members 削除失敗: ${error.message}`); process.exit(1); }
    console.log("✓ members 削除");
  }
  {
    const { error } = await sb.from("offices").delete().eq("id", OFFICE_ID);
    if (error) { console.error(`✗ offices 削除失敗: ${error.message}`); process.exit(1); }
    console.log("✓ offices 削除");
  }
  if (existsSync(csvDir)) {
    rmSync(csvDir, { recursive: true, force: true });
    console.log(`✓ CSV フォルダ削除: ${csvDir}`);
  }

  console.log("\n✅ 削除完了");
}

main().catch((e) => { console.error("ERROR:", e); process.exit(1); });
