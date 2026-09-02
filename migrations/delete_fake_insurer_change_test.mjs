/**
 * seed_fake_insurer_change_test.mjs で投入したテストデータの削除
 *
 *   node migrations/delete_fake_insurer_change_test.mjs              # DRY RUN
 *   node migrations/delete_fake_insurer_change_test.mjs --execute    # 削除実行
 *
 * marker `[fake テスト用-insurer-20260903]` と user_number `FAKEINS-%` に
 * 一致する行だけを消す。本番データには一切触らない。
 */
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const MARKER = "[fake テスト用-insurer-20260903]";
const OFFICE_NAME = `保険者変更検証事業所 ${MARKER}`;
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
    .from("clients").select("id").like("user_number", "FAKEINS-%");
  if (cErr) throw new Error(`利用者の取得に失敗: ${cErr.message}`);
  const clientIds = (clients ?? []).map((c) => c.id);
  const { data: offices, error: oErr } = await sb
    .from("offices").select("id").eq("name", OFFICE_NAME);
  if (oErr) throw new Error(`事業所の取得に失敗: ${oErr.message}`);
  const officeIds = (offices ?? []).map((o) => o.id);
  console.log(`対象利用者: ${clientIds.length} 名 / 対象事業所: ${officeIds.length} 件`);
  if (clientIds.length === 0 && officeIds.length === 0) {
    console.log("\n削除対象がありません (既に削除済み)。"); return;
  }

  const counts = {};
  for (const [table, col] of [
    ["kaigo_visit_schedule", "user_id"],
    ["shougai_certifications", "client_id"],
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

  if (!EXECUTE) { console.log("\nDRY RUN のため何も削除していません。"); return; }

  const del = async (table, col, ids) => {
    if (ids.length === 0) return;
    const { error } = await sb.from(table).delete().in(col, ids);
    if (error) throw new Error(`${table} DELETE 失敗: ${error.message}`);
    console.log(`  ${table}: 削除`);
  };
  await del("kaigo_visit_schedule", "user_id", clientIds);
  await del("shougai_certifications", "client_id", clientIds);
  await del("client_insurance_records", "client_id", clientIds);
  await del("client_office_assignments", "client_id", clientIds);
  await del("clients", "id", clientIds);
  await del("offices", "id", officeIds);

  const left = {};
  const { count: lc, error: e1 } = await sb.from("clients")
    .select("id", { count: "exact", head: true }).like("user_number", "FAKEINS-%");
  if (e1) throw new Error(`残存確認に失敗: ${e1.message}`);
  const { count: lo, error: e2 } = await sb.from("offices")
    .select("id", { count: "exact", head: true }).eq("name", OFFICE_NAME);
  if (e2) throw new Error(`残存確認に失敗: ${e2.message}`);
  const { count: lb, error: e3 } = await sb.from("shougai_certifications")
    .select("id", { count: "exact", head: true }).eq("notes", MARKER);
  if (e3) throw new Error(`残存確認に失敗: ${e3.message}`);
  left.clients = lc; left.offices = lo; left.shogai_cert = lb;
  console.log(`\n残存確認: 利用者 ${lc} / 事業所 ${lo} / shogai_cert ${lb}`);
  if (lc !== 0 || lo !== 0 || lb !== 0) throw new Error("削除しきれていない行があります");

  const metaPath = new URL("./_fake_insurer_change_test_meta.json", import.meta.url);
  if (existsSync(metaPath)) { unlinkSync(metaPath); console.log("メタ情報 JSON も削除しました"); }
  console.log("削除完了。");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
