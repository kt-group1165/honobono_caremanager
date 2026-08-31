// ============================================================================
// 「狩野 絹代」が 2 件できてしまったのを片付ける。
//
//   node migrations/fix_duplicate_client_kanou_kinuyo.mjs             # DRY RUN
//   node migrations/fix_duplicate_client_kanou_kinuyo.mjs --execute
//
// ── 何が起きたか (私の作業ミス) ────────────────────────────────────────
//   2026-08-31 11:32  A の高品マスタ取込が 狩野 絹代 を作った。
//                     ただし clients の 保険者番号/被保険者番号が **null**。
//   2026-08-31 11:50  fix_junk_user_number_owners.mjs (B) が、受け皿になって
//                     いた「佐藤 喜美子」から狩野さんの認定を戻すとき、
//                     既存を **(保険者番号, 被保険者番号) でしか探さなかった**。
//                     null なので見つからず、同じ人をもう 1 つ作った。
//
//   結果、同一人物 (生1943-02-13) が 2 件になった。どちらも
//   認定 121061|1002199030 要支援2 と Hana高品の割当を 1 つずつ持つだけで、
//   帳票・レセプト・シフト等の参照は無い。
//
// ── やること ────────────────────────────────────────────────────────────
//   ・後から作った側 (利番 121061-1002199030) を、認定・割当ごと削除する
//   ・残す側 (A が先に作った 利番 HN-2147483647) に 保険者/被保険者番号を入れる
//     → null のままだと同じ取り違えが再発する
//
//   ⚠ 消す前に、消す側に想定外の参照が無いかを全表で確認する。
//     1 件でもあれば触らずに中止する。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));

const KEEP = "2f4e4488-ed48-47ba-b2a2-59c9bc26ddbb";  // A が先に作った側
const DROP = "ce298275-46fe-4c5d-9fa0-7b5ddf0c650b";  // B が重複して作った側
const INSURER = "121061", INSURED = "1002199030";

const env = {};
for (const l of readFileSync(path.join(KAIGO, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

/** 消してよいのは「この 2 つだけ」。他に 1 件でもあれば中止する */
const OK_TO_DELETE = new Set(["client_insurance_records", "client_office_assignments"]);
const REFS = [
  ["client_insurance_records", "client_id"], ["client_office_assignments", "client_id"],
  ["client_kohi_records", "client_id"], ["client_hospitalizations", "client_id"],
  ["client_memos", "client_id"], ["kaigo_report_documents", "user_id"],
  ["kaigo_care_support_claims", "user_id"], ["kaigo_visit_schedule", "user_id"],
  ["kaigo_visit_records", "user_id"], ["kaigo_support_records", "user_id"],
  ["kaigo_care_plans", "user_id"], ["kaigo_assessments", "user_id"],
  ["kaigo_benefit_management", "user_id"], ["kaigo_monitoring_sheets", "user_id"],
  ["kaigo_health_records", "user_id"], ["kaigo_family_contacts", "user_id"],
  ["kaigo_medical_history", "user_id"], ["kaigo_adl_records", "user_id"],
  ["kaigo_emergency_sheets", "user_id"], ["kaigo_medical_insurance", "user_id"],
];

async function main() {
  console.log(`=== 重複した「狩野 絹代」を片付ける ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);

  const { data: rows, error } = await sb.from("clients")
    .select("id, name, user_number, birth_date, insurer_number, insured_number")
    .in("id", [KEEP, DROP]);
  if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
  if (rows.length !== 2) { console.log(`対象が ${rows.length} 件しかない → 是正済みとみなす`); return; }
  for (const c of rows) {
    console.log(`  ${c.id === KEEP ? "残す" : "消す"}  ${c.name} 利番${c.user_number} 生${c.birth_date} ${c.insurer_number ?? "null"}|${c.insured_number ?? "null"}`);
  }
  const keep = rows.find((r) => r.id === KEEP), drop = rows.find((r) => r.id === DROP);
  if (keep.birth_date !== drop.birth_date || keep.name !== drop.name) {
    console.error("✗ 氏名か生年月日が違う。同一人物と断定できないので触らない"); process.exit(2);
  }

  console.log("\n― 消す側の参照 ―");
  let blocking = 0;
  for (const [t, col] of REFS) {
    const { count, error: e } = await sb.from(t).select("*", { count: "exact", head: true }).eq(col, DROP);
    if (e) continue;                       // 表が無いものは飛ばす
    if (!count) continue;
    console.log(`   ${t}: ${count}`);
    if (!OK_TO_DELETE.has(t)) blocking += count;
  }
  if (blocking) { console.error(`✗ 消してよい表以外に ${blocking} 件の参照がある → 中止`); process.exit(2); }
  console.log("   (認定・事業所割当のみ。消して問題ない)");

  console.log(`\n残す側に 保険者${INSURER} / 被保番${INSURED} を入れる (null のままだと同じ取り違えが再発する)`);

  if (!EXECUTE) { console.log("\n(--execute で反映)"); return; }

  for (const [t, col] of [["client_office_assignments", "client_id"], ["client_insurance_records", "client_id"]]) {
    const { error: e } = await sb.from(t).delete().eq(col, DROP);
    if (e) { console.error(`✗ ${t} の削除に失敗: ${e.message}`); process.exit(1); }
  }
  const { error: de } = await sb.from("clients").delete().eq("id", DROP);
  if (de) { console.error(`✗ client の削除に失敗: ${de.message}`); process.exit(1); }
  const { error: ue } = await sb.from("clients")
    .update({ insurer_number: INSURER, insured_number: INSURED }).eq("id", KEEP);
  if (ue) { console.error(`✗ 番号の補完に失敗: ${ue.message}`); process.exit(1); }

  const { data: after } = await sb.from("clients")
    .select("id, name, user_number, birth_date, insurer_number, insured_number").eq("name", "狩野 絹代");
  console.log("\n✓ 片付きました");
  for (const c of after ?? []) console.log(`  ${c.name} 利番${c.user_number} 生${c.birth_date} ${c.insurer_number}|${c.insured_number}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
