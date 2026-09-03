/**
 * seed_fake_gendo_test.mjs で入れたテストデータを削除する
 *
 *   node migrations/delete_fake_gendo_test.mjs              # DRY RUN
 *   node migrations/delete_fake_gendo_test.mjs --execute    # 削除実行
 *
 * 判定は marker 由来のキーだけを使う (本番行に当たらないこと):
 *   clients.user_number LIKE 'FAKEGENDO-%'  (かつ address に marker)
 *   offices.name = 限度額検証事業所 <marker>
 * 子テーブルは上で確定した client_id / office_id でのみ消す。
 */
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const MARKER = "[fake テスト用-gendo-20260903]";
const OFFICE_NAME = `限度額検証事業所 ${MARKER}`;
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
  console.log(EXECUTE ? "=== 削除実行 ===" : "=== DRY RUN (--execute で削除) ===");

  const { data: cli, error: cErr } = await sb
    .from("clients").select("id, name, user_number, address").like("user_number", "FAKEGENDO-%");
  if (cErr) throw new Error(`clients 取得失敗: ${cErr.message}`);
  // 二重の安全確認: marker が address に入っている行だけを対象にする
  const targets = (cli ?? []).filter((c) => (c.address ?? "").includes(MARKER));
  const skipped = (cli ?? []).length - targets.length;
  if (skipped > 0) console.log(`⚠ user_number は一致するが marker が無い ${skipped} 行は対象外`);
  const ids = targets.map((c) => c.id);
  console.log(`対象利用者: ${ids.length} 名`);
  for (const c of targets) console.log(`  ${c.user_number} ${c.name}`);

  const { data: off, error: oErr } = await sb
    .from("offices").select("id, name").eq("name", OFFICE_NAME).maybeSingle();
  if (oErr) throw new Error(`offices 取得失敗: ${oErr.message}`);
  console.log(`対象事業所: ${off ? off.id : "(なし)"}`);

  const counts = {};
  const countIn = async (table, col) => {
    if (ids.length === 0) return 0;
    const { count, error } = await sb.from(table)
      .select("*", { count: "exact", head: true }).in(col, ids);
    if (error) { console.log(`  ${table}: 取得失敗 ${error.message}`); return -1; }
    return count ?? 0;
  };
  counts.kaigo_visit_schedule = await countIn("kaigo_visit_schedule", "user_id");
  counts.client_insurance_records = await countIn("client_insurance_records", "client_id");
  counts.client_kohi_records = await countIn("client_kohi_records", "client_id");
  counts.client_office_assignments = await countIn("client_office_assignments", "client_id");
  counts.kaigo_monthly_plan_units = await countIn("kaigo_monthly_plan_units", "client_id");
  counts.kaigo_gendo_allocation = await countIn("kaigo_gendo_allocation", "client_id");
  console.log("\n削除予定:", JSON.stringify(counts, null, 1));

  if (!EXECUTE) { console.log("\nDRY RUN のため何も削除していません。"); return; }
  if (ids.length === 0 && !off) { console.log("対象なし。"); return; }

  const del = async (table, col) => {
    if (ids.length === 0) return;
    const { error } = await sb.from(table).delete().in(col, ids);
    if (error) { console.log(`  ${table}: 削除失敗 ${error.message}`); return; }
    console.log(`  ${table}: 削除`);
  };
  // 子 → 親 の順
  await del("kaigo_gendo_allocation", "client_id");
  await del("kaigo_monthly_plan_units", "client_id");
  await del("kaigo_visit_schedule", "user_id");
  await del("client_kohi_records", "client_id");
  await del("client_insurance_records", "client_id");
  await del("client_office_assignments", "client_id");
  if (ids.length > 0) {
    const { error } = await sb.from("clients").delete().in("id", ids);
    if (error) throw new Error(`clients 削除失敗: ${error.message}`);
    console.log("  clients: 削除");
  }
  if (off) {
    const { error } = await sb.from("offices").delete().eq("id", off.id);
    if (error) throw new Error(`offices 削除失敗: ${error.message}`);
    console.log("  offices: 削除");
  }

  // 残存確認
  const { count: left } = await sb.from("clients")
    .select("id", { count: "exact", head: true }).like("user_number", "FAKEGENDO-%");
  const { count: leftSched } = await sb.from("kaigo_visit_schedule")
    .select("id", { count: "exact", head: true })
    .gte("visit_date", "2026-11-01").lte("visit_date", "2026-11-30");
  const { count: leftOff } = await sb.from("offices")
    .select("id", { count: "exact", head: true }).eq("name", OFFICE_NAME);
  console.log(`\n残存確認: 利用者 ${left} / 2026-11 実績 ${leftSched} / 事業所 ${leftOff}`);

  const meta = fileURLToPath(new URL("./_fake_gendo_test_meta.json", import.meta.url));
  if (existsSync(meta)) { unlinkSync(meta); console.log("メタ情報ファイルを削除しました"); }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
