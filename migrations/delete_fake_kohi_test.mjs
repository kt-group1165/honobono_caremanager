/**
 * seed_fake_kohi_test.mjs で投入したテストデータの削除
 *
 *   node migrations/delete_fake_kohi_test.mjs              # DRY RUN
 *   node migrations/delete_fake_kohi_test.mjs --execute    # 削除実行
 *
 * marker `[fake テスト用-kohi-20260903]` と user_number `FAKEKOHI-%` に
 * 一致する行だけを消す。本番データには一切触らない。
 * 削除順は FK の子 → 親 (実績 → 公費 → 認定 → 割当 → 利用者 → 事業所)。
 */
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const MARKER = "[fake テスト用-kohi-20260903]";
const OFFICE_NAME = `公費併用検証事業所 ${MARKER}`;
const EXECUTE = process.argv.includes("--execute");

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
  if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  console.log(`${EXECUTE ? "=== 削除実行 ===" : "=== DRY RUN (--execute で削除) ==="}`);
  console.log(`marker: ${MARKER}\n`);

  const { data: clients, error: cErr } = await sb
    .from("clients").select("id, name, user_number").like("user_number", "FAKEKOHI-%");
  if (cErr) throw new Error(`利用者の取得に失敗: ${cErr.message}`);
  const clientIds = (clients ?? []).map((c) => c.id);
  console.log(`対象利用者: ${clientIds.length} 名`);

  const { data: offices, error: oErr } = await sb
    .from("offices").select("id, name").eq("name", OFFICE_NAME);
  if (oErr) throw new Error(`事業所の取得に失敗: ${oErr.message}`);
  const officeIds = (offices ?? []).map((o) => o.id);
  console.log(`対象事業所: ${officeIds.length} 件`);

  if (clientIds.length === 0 && officeIds.length === 0) {
    console.log("\n削除対象がありません (既に削除済み)。");
    return;
  }

  // 件数だけ先に出す (DRY RUN の材料)
  const counts = {};
  for (const [table, col] of [
    ["kaigo_visit_schedule", "user_id"],
    ["client_kohi_records", "client_id"],
    ["client_insurance_records", "client_id"],
    ["client_office_assignments", "client_id"],
  ]) {
    if (clientIds.length === 0) { counts[table] = 0; continue; }
    const { count, error } = await sb
      .from(table).select("id", { count: "exact", head: true }).in(col, clientIds);
    if (error) throw new Error(`${table} の件数取得に失敗: ${error.message}`);
    counts[table] = count ?? 0;
  }
  console.log("\n削除対象:");
  for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(26)} ${n} 件`);
  console.log(`  ${"clients".padEnd(26)} ${clientIds.length} 件`);
  console.log(`  ${"offices".padEnd(26)} ${officeIds.length} 件`);

  if (!EXECUTE) {
    console.log("\nDRY RUN のため何も削除していません。");
    return;
  }

  const del = async (table, col, ids) => {
    if (ids.length === 0) return;
    const { error } = await sb.from(table).delete().in(col, ids);
    if (error) throw new Error(`${table} DELETE 失敗: ${error.message}`);
    console.log(`  ${table}: 削除`);
  };

  await del("kaigo_visit_schedule", "user_id", clientIds);
  await del("client_kohi_records", "client_id", clientIds);
  await del("client_insurance_records", "client_id", clientIds);
  await del("client_office_assignments", "client_id", clientIds);
  await del("clients", "id", clientIds);
  await del("offices", "id", officeIds);

  // 残存確認 (0 件になったことを実測する)
  const { count: leftClients, error: lcErr } = await sb
    .from("clients").select("id", { count: "exact", head: true }).like("user_number", "FAKEKOHI-%");
  if (lcErr) throw new Error(`残存確認に失敗: ${lcErr.message}`);
  const { count: leftOffices, error: loErr } = await sb
    .from("offices").select("id", { count: "exact", head: true }).eq("name", OFFICE_NAME);
  if (loErr) throw new Error(`残存確認に失敗: ${loErr.message}`);
  const { count: leftKohi, error: lkErr } = await sb
    .from("client_kohi_records").select("id", { count: "exact", head: true }).eq("notes", MARKER);
  if (lkErr) throw new Error(`残存確認に失敗: ${lkErr.message}`);
  console.log(`\n残存確認: 利用者 ${leftClients} / 事業所 ${leftOffices} / 公費 ${leftKohi}`);
  if (leftClients !== 0 || leftOffices !== 0 || leftKohi !== 0) {
    throw new Error("削除しきれていない行があります");
  }

  const metaPath = new URL("./_fake_kohi_test_meta.json", import.meta.url);
  if (existsSync(metaPath)) { unlinkSync(metaPath); console.log("メタ情報 JSON も削除しました"); }
  console.log("削除完了。");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
