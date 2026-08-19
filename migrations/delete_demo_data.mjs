// ============================================================================
// デモ / テスト用に投入したデータを消す。
//
// ── 何がデモだったか ──────────────────────────────────────────────────
//   1) 訪問入浴 (kaigo_bath_*) の 2026-07 一式
//      2026-07-15 の 訪問入浴シフト機能 (第3弾) を作ったときの seed。
//      notes に "[fake テスト用-bath-shift]" が入っている。
//      bath_visit_records の 2 件だけ marker が無いが、同じ office・同じ
//      2026-07-03 で 07-08 に画面から作った動作確認分なので同じ扱いにする。
//
//   2) その 訪問入浴 に紐づく 利用者 15 名
//      A001〜E001 (2026-05-25) と OY001〜OY010 (2026-06-19)。
//      **訪問介護のシフト・実績には 1 件も出てこない**ことを確認済み。
//      アセスメント・健康記録・支援経過など 約 500 行がぶら下がっている。
//
//   3) 訪問介護実績 4 行 ("[fake テスト用-visit]" / 2026-05 / 靑木 敬子)
//      ⚠ 靑木 敬子 は**実在の利用者**。この 4 行だけ消して本人は残す。
//
// ── 消さないもの ──────────────────────────────────────────────────────
//   ・offices の 訪問入浴 5 事業所 (実在のマスタ)
//   ・kaigo_bath_teams の 号車 (1号車/2号車 — 実運用でも使う設定)
//   ・demo_loans (名前は demo だが**福祉用具のデモ機貸出**。実業務データ)
//
//   node migrations/delete_demo_data.mjs            # DRY RUN
//   node migrations/delete_demo_data.mjs --execute  # 削除 (先に JSON バックアップ)
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));

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

// 子 → 親 の順。ここを流し切ってから clients を消す。
const CLIENT_CHILDREN = [
  ["bath_billing_status", "client_id"],
  ["kaigo_bath_visit_records", "client_id"],
  ["kaigo_bath_schedule", "client_id"],
  ["kaigo_bath_patterns", "client_id"],
  ["riyou_seikyu_payments", "client_id"],
  ["kaigo_report_documents", "user_id"],
  ["care_plan_elements", "client_id"],
  ["kaigo_user_contracts", "user_id"],
  ["kaigo_assessments", "user_id"],
  ["kaigo_adl_records", "user_id"],
  ["kaigo_health_records", "user_id"],
  ["kaigo_medical_history", "user_id"],
  ["kaigo_medical_insurance", "user_id"],
  ["kaigo_emergency_sheets", "user_id"],
  ["kaigo_family_contacts", "user_id"],
  ["kaigo_support_records", "user_id"],
  ["client_memos", "client_id"],
  ["client_kohi_records", "client_id"],
  ["client_insurance_records", "client_id"],
  ["client_office_assignments", "client_id"],
];

async function main() {
  console.log(`=== デモデータ削除 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  // ── 1) 訪問入浴のデモ利用者を特定 ────────────────────────────────
  const ids = new Set();
  for (const [tb, col] of [["kaigo_bath_schedule", "client_id"], ["kaigo_bath_visit_records", "client_id"]]) {
    const { data, error } = await sb.from(tb).select(col);
    if (error) { console.error(`✗ ${tb}: ${error.message}`); process.exit(1); }
    for (const r of data) if (r[col]) ids.add(r[col]);
  }
  const clientIds = [...ids];
  const { data: cs, error: eC } = await sb
    .from("clients").select("id, user_number, name, created_at").in("id", clientIds);
  if (eC) { console.error(`✗ clients: ${eC.message}`); process.exit(1); }

  console.log(`【1】訪問入浴のデモ利用者 ${cs.length} 名`);
  for (const c of cs.sort((a, b) => String(a.user_number).localeCompare(String(b.user_number))))
    console.log(`     ${String(c.user_number ?? "").padEnd(8)} ${c.name}`);

  // 実業務データに出ていないことを毎回確かめる (安全弁)
  for (const [tb, col] of [["kaigo_visit_schedule", "user_id"], ["kaigo_visit_records", "user_id"]]) {
    const { data, error } = await sb.from(tb).select("id").in(col, clientIds);
    if (error) { console.error(`✗ ${tb}: ${error.message}`); process.exit(1); }
    if (data.length) {
      console.error(`\n✗ 中止: ${tb} に ${data.length} 件ある。実業務データが混ざっている可能性。`);
      process.exit(1);
    }
  }
  console.log(`     → 訪問介護のシフト・実績には 0 件 (デモ限定を確認)\n`);

  // ── 2) ぶら下がっている行を数える ────────────────────────────────
  const backup = { generated_at: new Date().toISOString(), clients: cs, children: {} };
  let total = 0;
  console.log(`【2】ぶら下がり`);
  for (const [tb, col] of CLIENT_CHILDREN) {
    const { data, error } = await sb.from(tb).select("*").in(col, clientIds);
    if (error) { console.error(`  ✗ ${tb}: ${error.message}`); process.exit(1); }
    if (!data.length) continue;
    backup.children[tb] = data;
    total += data.length;
    console.log(`     ${tb.padEnd(30)} ${String(data.length).padStart(4)}`);
  }
  console.log(`     ${"小計".padEnd(30)} ${String(total).padStart(4)}\n`);

  // ── 3) 訪問介護実績の fake 4 行 (利用者は実在なので行だけ消す) ────
  const { data: fakeVisits, error: eF } = await sb
    .from("kaigo_visit_records").select("*").like("notes", "%[fake テスト用%");
  if (eF) { console.error(`✗ kaigo_visit_records: ${eF.message}`); process.exit(1); }
  backup.fake_visit_records = fakeVisits;
  console.log(`【3】訪問介護実績の fake 行 ${fakeVisits.length} 件 (利用者本人は残す)`);
  for (const v of fakeVisits) console.log(`     ${v.visit_date} ${v.service_type} ${v.notes}`);

  // ── 4) 孤児になる bath 行 (利用者に紐づかないもの) ───────────────
  console.log(`\n【4】利用者に紐づかない 訪問入浴の残り`);
  const orphan = {};
  for (const tb of ["kaigo_bath_team_days"]) {
    const { data, error } = await sb.from(tb).select("*");
    if (error) { console.error(`  ✗ ${tb}: ${error.message}`); process.exit(1); }
    if (data.length) { orphan[tb] = data; console.log(`     ${tb.padEnd(30)} ${String(data.length).padStart(4)}`); }
  }
  backup.orphans = orphan;

  console.log(`\n合計 ${total + cs.length + fakeVisits.length + Object.values(orphan).reduce((a, v) => a + v.length, 0)} 行`);
  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で削除します (先に JSON バックアップを書きます)。"); return; }

  // ── 5) バックアップ → 削除 ──────────────────────────────────────
  const dir = path.join(KAIGO, "migrations", "_backup");
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `demo_data_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.json`);
  writeFileSync(dest, JSON.stringify(backup, null, 1), "utf8");
  console.log(`\n✓ バックアップ: ${path.relative(KAIGO, dest)}`);

  for (const [tb, rows] of Object.entries(orphan)) {
    const { error } = await sb.from(tb).delete().in("id", rows.map((r) => r.id));
    if (error) { console.error(`✗ ${tb}: ${error.message}`); process.exit(1); }
    console.log(`  ✓ ${tb.padEnd(30)} ${rows.length}`);
  }
  for (const [tb, col] of CLIENT_CHILDREN) {
    if (!backup.children[tb]) continue;
    const { error } = await sb.from(tb).delete().in(col, clientIds);
    if (error) { console.error(`✗ ${tb}: ${error.message}`); process.exit(1); }
    console.log(`  ✓ ${tb.padEnd(30)} ${backup.children[tb].length}`);
  }
  if (fakeVisits.length) {
    const { error } = await sb.from("kaigo_visit_records").delete().in("id", fakeVisits.map((r) => r.id));
    if (error) { console.error(`✗ kaigo_visit_records: ${error.message}`); process.exit(1); }
    console.log(`  ✓ ${"kaigo_visit_records (fake)".padEnd(30)} ${fakeVisits.length}`);
  }
  const { error: eD } = await sb.from("clients").delete().in("id", clientIds);
  if (eD) { console.error(`✗ clients: ${eD.message}`); process.exit(1); }
  console.log(`  ✓ ${"clients".padEnd(30)} ${clientIds.length}`);

  console.log(`\n✓ 完了`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
