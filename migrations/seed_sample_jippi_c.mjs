// ============================================================================
// 利用者請求の実費 (キャンセル料) サンプルデータ — SAMPLE_DATA_PROTOCOL / マーカー c
//
//   node migrations/seed_sample_jippi_c.mjs             # DRY RUN
//   node migrations/seed_sample_jippi_c.mjs --execute   # 投入
//   node migrations/seed_sample_jippi_c.mjs --delete    # ★ 撤去
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
//   キャンセル料 → 利用実費 (`riyou_jippi_entries`) の連動は
//   `src/lib/visit-cancel.ts` に実装済みだが、**本番で一度も動いていない**:
//     kaigo_visit_schedule で status='cancelled' の予定  ★ 0 件
//     riyou_jippi_entries                                ★ 0 行
//   「schedule_id が UNIQUE なので二重計上しない」は **設計の主張**でしかない。
//   ★ 実際に 2 回キャンセルして 1 行しか増えないことを確かめる (3-9)。
//
// ── 前提 ────────────────────────────────────────────────────────────────
//   対象月  2026-12 のみ / マーカー ZC2nn ・ [sample-c] ・ [sample-c-20260903]
//   事業所  実在の Ｈａｎａヘルパーステーション高品 (1270402116)。
//           ★ offices は 1 バイトも変更しない
//   ⚠ clients.gender の CHECK は "男"/"女" (members の "男性"/"女性" とは違う)
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");
const MONTH = "2026-12";
const TENANT = "kt-group";
const MARK = "[sample-c-20260903]";
const SUFFIX = "[sample-c]";
const NUM_PREFIX = "ZC2"; // 訪問入浴 ZC0 / 福祉用具 ZC1 と分ける
const OFFICE_BN = "1270402116";

const env = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const NUMS = [`${NUM_PREFIX}01`];
/** 3 予定: ①キャンセル料あり ②キャンセル料 0 ③通常 (実費が付かないこと) */
const VISITS = [
  { date: `${MONTH}-07`, start: "09:00", end: "10:00", svc: "身体介護2", tag: "①キャンセル料あり" },
  { date: `${MONTH}-14`, start: "09:00", end: "10:00", svc: "生活援助2", tag: "②キャンセル料 0" },
  { date: `${MONTH}-21`, start: "09:00", end: "10:00", svc: "身体介護1", tag: "③通常 (実績)" },
];

async function findOffice() {
  const { data, error } = await sb.from("offices").select("id, name, business_number").eq("business_number", OFFICE_BN);
  if (error) throw new Error(`offices: ${error.message}`);
  if (!data?.length) throw new Error(`事業所番号 ${OFFICE_BN} の office がありません`);
  return data[0];
}

async function findClients() {
  const { data, error } = await sb.from("clients").select("id, name, user_number").in("user_number", NUMS);
  if (error) throw new Error(`clients: ${error.message}`);
  return data ?? [];
}

if (DELETE) {
  console.log(`=== 撤去 (マーカー ${NUM_PREFIX}*) ===`);
  const cl = await findClients();
  if (!cl.length) { console.log("  対象なし ✅"); process.exit(0); }
  const ids = cl.map((c) => c.id);
  console.log(`  対象 clients: ${cl.map((c) => c.user_number).join(",")}`);
  // ⚠ 利用者を指す列名が表ごとに違う。
  //   riyou_jippi_entries / client_office_assignments → client_id
  //   ★ kaigo_visit_schedule                          → **user_id**
  //   最初 client_id で全部消そうとして途中で落ち、サンプルが残った (2026-09-03)。
  for (const [t, col] of [
    ["riyou_jippi_entries", "client_id"],
    ["kaigo_visit_schedule", "user_id"],
    ["client_office_assignments", "client_id"],
  ]) {
    const { error, count } = await sb.from(t).delete({ count: "exact" }).in(col, ids);
    if (error) { console.error(`✗ ${t}: ${error.message}`); process.exit(1); }
    console.log(`  ${t.padEnd(28)} ${count} 行 削除`);
  }
  const { error: e2, count: c2 } = await sb.from("clients").delete({ count: "exact" }).in("id", ids);
  if (e2) { console.error(`✗ clients: ${e2.message}`); process.exit(1); }
  console.log(`  clients                      ${c2} 行 削除`);
  const left = await findClients();
  console.log(`  ★ 残り ${left.length} 件 ${left.length === 0 ? "✅ 0 件を確認" : "⚠"}`);
  process.exit(0);
}

const office = await findOffice();
console.log(`=== 実費(キャンセル料) サンプル投入 ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===`);
console.log(`    対象月 ${MONTH} / マーカー ${NUM_PREFIX}* ・ ${SUFFIX}`);
console.log(`\n  事業所: ${office.name} (${office.business_number}) — **変更しない**`);
console.log(`  投入予定: 利用者 1 名 / 訪問予定 ${VISITS.length} 件`);
for (const v of VISITS) console.log(`     ${v.date} ${v.start}-${v.end} ${v.svc}  ${v.tag}`);
console.log(`\n  ⚠ キャンセル料の付与は seed では **やらない**。`);
console.log(`     本番の関数 (syncCancelFeeJippi) を検査 script から呼んで確かめる:`);
console.log(`       npx tsx scripts/jippi-cancel-check.mts`);

const existing = await findClients();
if (existing.length) { console.log(`\n  ⚠ 既に ${existing.length} 件あります。先に --delete してください`); process.exit(0); }
if (!EXECUTE) { console.log(`\n【DRY RUN】書き込んでいません。--execute で投入`); process.exit(0); }

const { data: ins, error: e1 } = await sb.from("clients").insert(NUMS.map((num) => ({
  tenant_id: TENANT, user_number: num, name: `実費見本 太郎 ${SUFFIX}`,
  furigana: "ジッピミホン タロウ", gender: "男", birth_date: "1938-04-12",
  status: "active",
}))).select("id, user_number");
if (e1) { console.error(`✗ clients: ${e1.message}`); process.exit(1); }
const cid = ins[0].id;
console.log(`  clients                      ${ins.length} 行`);

const { error: e2 } = await sb.from("client_office_assignments").insert({
  tenant_id: TENANT, client_id: cid, office_id: office.id,
});
if (e2) { console.error(`✗ client_office_assignments: ${e2.message}`); process.exit(1); }
console.log(`  client_office_assignments    1 行`);

const { data: sch, error: e3 } = await sb.from("kaigo_visit_schedule").insert(VISITS.map((v) => ({
  tenant_id: TENANT, user_id: cid, office_id: office.id,
  visit_date: v.date, start_time: v.start, end_time: v.end,
  service_type: v.svc, status: "completed", system: "介護", notes: MARK,
}))).select("id, visit_date");
if (e3) { console.error(`✗ kaigo_visit_schedule: ${e3.message}`); process.exit(1); }
console.log(`  kaigo_visit_schedule         ${sch.length} 行`);

// ★ 件数確認 (DB に聞き直す)
const { count, error: e4 } = await sb.from("kaigo_visit_schedule")
  .select("*", { count: "exact", head: true }).eq("user_id", cid);
if (e4) { console.error(`✗ 確認に失敗: ${e4.message}`); process.exit(1); }
console.log(`\n  ★ 件数確認: サンプル利用者の予定 ${count} 件`);
console.log(`\n  次: npx tsx scripts/jippi-cancel-check.mts`);
