/**
 * ケアプラン→モニタリング→支援経過 連鎖のサンプル検証 (実DB往復・READ ONLY)
 * migrations/seed_sample_careplan_chain_g.mjs --execute で投入したサンプルを対象にする。
 *
 *   npx tsx scripts/careplan-selection-verify.mts        (純関数の境界値。DB不使用)
 *   npx tsx scripts/careplan-chain-sample-verify.mts      (このファイル。実DB往復)
 *
 * 4画面が実際に発行するクエリと同じ形で読み、selectCurrentPlanForReports /
 * selectCurrentPlanWithFallback (src/lib/careplan-selection.ts, 2026-09-05 に
 * 5箇所のインラインコピーを統合) が実データに対しても同じ結論になることを確認する。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { selectCurrentPlanForReports, selectCurrentPlanWithFallback } from "../src/lib/careplan-selection";

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY が無い");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
void fileURLToPath;

let n = 0, ng = 0;
function eq(label: string, actual: unknown, expected: unknown) {
  n++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) ng++;
  console.log(`  ${ok ? "OK " : "NG "} ${label.padEnd(60)} ${ok ? "" : `実際=${JSON.stringify(actual)} 期待=${JSON.stringify(expected)}`}`);
}

const MK = "[sample-g]";
const { data: clients, error: cErr } = await sb.from("clients").select("id,name,care_level").like("user_number", "ZG%");
if (cErr) throw cErr;
const mine = (clients ?? []).filter((c) => String(c.name ?? "").includes(MK));
console.log(`【分母】サンプルクライアント (tag=g): ${mine.length} 名`);
if (mine.length !== 4) {
  console.log(`  ⚠ 期待は4名 (A/B/C/D)。migrations/seed_sample_careplan_chain_g.mjs --execute を先に実行してください`);
  process.exit(mine.length === 0 ? 0 : 1);
}
const byName = (suffix: string) => mine.find((c) => c.name?.includes(suffix));
const cA = byName("サンプル1"), cB = byName("サンプル2"), cC = byName("サンプル3"), cD = byName("サンプル4");
if (!cA || !cB || !cC || !cD) throw new Error("A/B/C/Dのいずれかが見つからない (氏名パターン不一致)");

async function fetchPlans(userId: string) {
  const { data, error } = await sb.from("kaigo_care_plans").select("id,status,start_date,end_date,long_term_goals")
    .eq("user_id", userId).order("start_date", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

console.log("\n═══ クライアントA (期限切れの計画のみ) ═══");
{
  const plans = await fetchPlans(cA.id);
  eq("計画は1件", plans.length, 1);
  const forReports = selectCurrentPlanForReports(plans);
  const forOther = selectCurrentPlanWithFallback(plans);
  eq("reports: status=activeなので選ばれる (期限切れでも選ばれてしまう=既知の穴)", forReports?.id, plans[0]?.id);
  eq("monitoring/support-records: 同じ計画が選ばれる", forOther?.id, plans[0]?.id);
  const chosenRaw = plans.find((p) => p.id === forReports?.id);
  console.log(`     → 選ばれた計画の end_date = ${chosenRaw?.end_date} (2026-12時点で既に期限切れ)`);
}

console.log("\n═══ クライアントB (期限切れ+現在有効。期限切れの方がstart_dateが新しい) ═══");
{
  const plans = await fetchPlans(cB.id);
  eq("計画は2件", plans.length, 2);
  const expired = plans.find((p) => p.long_term_goals?.includes("期限切れ"));
  const valid = plans.find((p) => p.long_term_goals?.includes("現在有効"));
  if (!expired || !valid) throw new Error("BのplanをテキストマーカーでOA判別できない");
  const forReports = selectCurrentPlanForReports(plans);
  const forOther = selectCurrentPlanWithFallback(plans);
  eq("★ reports: 期限切れの方(start_dateが新しい)が選ばれてしまう (バグの実データ確認)", forReports?.id, expired.id);
  eq("★ monitoring/support-records: 同様に期限切れの方が選ばれる", forOther?.id, expired.id);
  // 第2表・モニタリング・支援経過は「現在有効」計画(valid)にしか紐付けていない →
  // 誤って選ばれた expired.id で検索すると空になることを実際に確認する
  const { data: svc } = await sb.from("kaigo_care_plan_services").select("*").eq("care_plan_id", expired.id);
  const { data: svcValid } = await sb.from("kaigo_care_plan_services").select("*").eq("care_plan_id", valid.id);
  eq("★ 選ばれてしまう期限切れ計画には第2表が0件 (画面には何も出ない)", (svc ?? []).length, 0);
  eq("実際のサービス内容は「現在有効」計画の方に3件中1件ある", (svcValid ?? []).length, 1);
  const { data: mon } = await sb.from("kaigo_monitoring_sheets").select("*").eq("care_plan_id", expired.id);
  const { data: monValid } = await sb.from("kaigo_monitoring_sheets").select("*").eq("care_plan_id", valid.id);
  eq("★ 選ばれてしまう期限切れ計画にはモニタリングシートが0件", (mon ?? []).length, 0);
  eq("実際のモニタリングは「現在有効」計画の方にある", (monValid ?? []).length, 1);
  const { data: sup } = await sb.from("kaigo_support_records").select("*").eq("care_plan_id", expired.id);
  const { data: supValid } = await sb.from("kaigo_support_records").select("*").eq("care_plan_id", valid.id);
  eq("★ 選ばれてしまう期限切れ計画には支援経過が0件", (sup ?? []).length, 0);
  eq("実際の支援経過は「現在有効」計画の方にある", (supValid ?? []).length, 1);
  console.log("     → クライアントBは実際にはケアプラン・第2表・モニタリング・支援経過が全部揃っているのに、");
  console.log("       選択ロジックが期限切れの計画を選んでしまうため、4画面すべてで「何も無い」ように見える。");
}

console.log("\n═══ クライアントC (status=completedのみ) ═══");
{
  const plans = await fetchPlans(cC.id);
  eq("計画は1件 (completed)", plans.length, 1);
  eq("plan.status = completed", plans[0]?.status, "completed");
  const forReports = selectCurrentPlanForReports(plans);
  const forOther = selectCurrentPlanWithFallback(plans);
  eq("① reports: activeが無いのでnull → 実装は空プランを自動生成する", forReports, null);
  eq("② monitoring/support-records: フォールバックでcompletedの計画を拾う (空にならない)", forOther?.id, plans[0]?.id);
  const { data: svc } = await sb.from("kaigo_care_plan_services").select("*").eq("care_plan_id", plans[0]!.id);
  eq("実際のサービス内容(第2表)はこの completed 計画に紐付いている", (svc ?? []).length, 1);
  console.log("     → reportsで開くと「有効なケアプランが無い」ため空の新規プランが自動生成され、");
  console.log("       実在するcompleted計画の内容(第2表含む)が見えなくなる。");
  console.log("       monitoring/support-recordsはcompleted計画を拾うので見える (画面ごとに挙動が違う)。");
}

console.log("\n═══ クライアントD (計画0件・正常系) ═══");
{
  const plans = await fetchPlans(cD.id);
  eq("計画は0件", plans.length, 0);
  eq("reports: null (「有効なケアプランがありません」→空プラン自動生成)", selectCurrentPlanForReports(plans), null);
  eq("monitoring/support-records: null (「有効なケアプランがありません」が正しく出る)", selectCurrentPlanWithFallback(plans), null);
}

console.log("\n═══ kaigo_monitoring_sheets (実データ0行だったテーブル) ═══");
{
  const { data, error } = await sb.from("kaigo_monitoring_sheets").select("id,user_id,monitoring_date").in("user_id", [cA.id, cB.id, cC.id]);
  if (error) throw error;
  eq("サンプル3件が実際にINSERTされ読み出せる (実データ0行だったテーブルへの書込・読出の生存確認)", (data ?? []).length, 3);
}

console.log(`\n══ 検査 ${n} 件 / NG ${ng} 件 ══`);
if (ng > 0) process.exitCode = 1;
console.log("\n次: node migrations/seed_sample_careplan_chain_g.mjs --delete --execute で撤去してください");
