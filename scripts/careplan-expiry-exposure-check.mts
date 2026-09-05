/**
 * ケアプラン選択ロジックの「期限切れ未チェック」バグ (2026-09-05発見) の
 * 実データでの規模を測る (READ ONLY・DB書換なし・断定しない・H割当)
 *
 *   npx tsx scripts/careplan-expiry-exposure-check.mts
 *
 * ── 前提 (src/lib/careplan-selection.ts) ─────────────────────────────────
 *   現在有効な計画の選択は status='active' の中で start_date が最新のものを
 *   無条件に選ぶ。end_date (有効期間終了日) は一切見ない。
 *
 * ── 測るもの ──────────────────────────────────────────────────────────
 *   ① status='active' なのに end_date が今日より前の計画を持つ利用者数
 *   ② そのうち「選択ロジックが実際にその期限切れ計画を選んでしまい、
 *      かつ同じ利用者に選ばれるべき有効な計画が他にある」利用者数 (=B型)
 *   ③ ②の利用者について、選ばれるべき有効な計画に紐付いていて
 *      画面から見えなくなっている kaigo_care_plan_services /
 *      kaigo_monitoring_sheets / kaigo_support_records の件数
 *   ④ ②の事業所別内訳 (client_office_assignments 経由)
 *
 * ⚠ 直さない。測るだけ。
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { selectCurrentPlanForReports, type CarePlanForSelection } from "../src/lib/careplan-selection";

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY が無い。分母が作れないので中止する");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const now = new Date();
const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
console.log(`══ ケアプラン「期限切れ未チェック」の実データ規模測定 (基準日 ${TODAY}・READ ONLY) ══\n`);

async function pageAll<T>(table: string, select: string, orderCol = "id"): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from(table).select(select).order(orderCol).range(from, from + 999);
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return out;
}

type PlanRow = CarePlanForSelection & { user_id: string; end_date: string | null };
const allPlans = await pageAll<PlanRow>("kaigo_care_plans", "id,user_id,status,start_date,end_date");
console.log(`【分母】kaigo_care_plans 全件: ${allPlans.length} 件`);

const byUser = new Map<string, PlanRow[]>();
for (const p of allPlans) {
  if (!byUser.has(p.user_id)) byUser.set(p.user_id, []);
  byUser.get(p.user_id)!.push(p);
}
console.log(`【分母】ケアプランを持つ利用者: ${byUser.size} 名\n`);

const isExpired = (p: PlanRow) => p.end_date != null && p.end_date < TODAY;

// ① status='active' なのに期限切れの計画を持つ利用者
const usersWithExpiredActive: string[] = [];
let expiredActivePlanCount = 0;
for (const [userId, plans] of byUser) {
  const hit = plans.filter((p) => p.status === "active" && isExpired(p));
  if (hit.length > 0) { usersWithExpiredActive.push(userId); expiredActivePlanCount += hit.length; }
}
console.log(`① status='active' かつ期限切れの計画を持つ利用者: ${usersWithExpiredActive.length} 名 (該当プラン ${expiredActivePlanCount} 件 / 全 ${allPlans.length} 件)`);

// ② 実際に選択ロジックが期限切れを選んでしまい、かつ有効な代替がある利用者 (B型)
type BCase = { userId: string; selectedExpiredPlanId: string; hiddenValidPlanIds: string[] };
const bCases: BCase[] = [];
for (const [userId, plans] of byUser) {
  const active = plans.filter((p) => p.status === "active");
  if (active.length < 2) continue; // B型は「複数のactive計画」が前提
  const selected = selectCurrentPlanForReports(active);
  if (!selected) continue;
  const selectedRaw = active.find((p) => p.id === selected.id)!;
  if (!isExpired(selectedRaw)) continue; // 選ばれたのが期限切れでなければ対象外
  const hiddenValid = active.filter((p) => p.id !== selectedRaw.id && !isExpired(p));
  if (hiddenValid.length === 0) continue; // 有効な代替が無ければ「隠れている」とは言えない
  bCases.push({ userId, selectedExpiredPlanId: selectedRaw.id, hiddenValidPlanIds: hiddenValid.map((p) => p.id) });
}
console.log(`② ★ 実際に期限切れが選ばれ、有効な代替が隠れている利用者 (B型): ${bCases.length} 名 / ①の${usersWithExpiredActive.length}名中`);

if (bCases.length > 0) {
  // ③ 隠れている有効プランに紐付く記録件数
  const hiddenPlanIds = [...new Set(bCases.flatMap((c) => c.hiddenValidPlanIds))];
  const [services, sheets, records] = await Promise.all([
    pageAll<{ care_plan_id: string }>("kaigo_care_plan_services", "care_plan_id"),
    pageAll<{ care_plan_id: string | null }>("kaigo_monitoring_sheets", "care_plan_id"),
    pageAll<{ care_plan_id: string | null }>("kaigo_support_records", "care_plan_id"),
  ]);
  const hiddenSet = new Set(hiddenPlanIds);
  const hiddenServices = services.filter((s) => hiddenSet.has(s.care_plan_id)).length;
  const hiddenSheets = sheets.filter((s) => s.care_plan_id && hiddenSet.has(s.care_plan_id)).length;
  const hiddenRecords = records.filter((r) => r.care_plan_id && hiddenSet.has(r.care_plan_id)).length;
  console.log(`\n③ 隠れている有効プラン (${hiddenPlanIds.length}件) に紐付く記録:`);
  console.log(`   kaigo_care_plan_services (第2表): ${hiddenServices} 件 (分母 ${services.length} 件)`);
  console.log(`   kaigo_monitoring_sheets:          ${hiddenSheets} 件 (分母 ${sheets.length} 件)`);
  console.log(`   kaigo_support_records:            ${hiddenRecords} 件 (分母 ${records.length} 件)`);

  // ④ 事業所別内訳
  const bUserIds = bCases.map((c) => c.userId);
  const assigns = await (async () => {
    const out: { client_id: string; office_id: string }[] = [];
    for (let i = 0; i < bUserIds.length; i += 200) {
      const chunk = bUserIds.slice(i, i + 200);
      const { data, error } = await sb.from("client_office_assignments").select("client_id,office_id").in("client_id", chunk);
      if (error) throw error;
      out.push(...(data ?? []));
    }
    return out;
  })();
  const officeIds = [...new Set(assigns.map((a) => a.office_id))];
  const { data: offices } = await sb.from("offices").select("id,name").in("id", officeIds);
  const officeName = new Map((offices ?? []).map((o) => [o.id, o.name]));
  const officeCounts = new Map<string, Set<string>>();
  for (const a of assigns) {
    if (!bUserIds.includes(a.client_id)) continue;
    if (!officeCounts.has(a.office_id)) officeCounts.set(a.office_id, new Set());
    officeCounts.get(a.office_id)!.add(a.client_id);
  }
  console.log(`\n④ 事業所別内訳 (B型利用者が割り当てられている事業所。1名が複数事業所に出ることがある):`);
  for (const [officeId, clientSet] of [...officeCounts.entries()].sort((a, b) => b[1].size - a[1].size)) {
    console.log(`   ${(officeName.get(officeId) ?? officeId).padEnd(28)} ${clientSet.size} 名`);
  }
  const TAKASHINA_OFFICE = "18dab72e-0445-49f1-a8fc-44637f9fd676";
  console.log(`\n   高品居宅支援センター: ${officeCounts.get(TAKASHINA_OFFICE)?.size ?? 0} 名`);
} else {
  console.log("\n② が0名のため③④は該当なし。");
}

console.log(`\n══ まとめ ══`);
console.log(`①期限切れactive計画を持つ利用者: ${usersWithExpiredActive.length} 名`);
console.log(`②実際に隠れている利用者(B型): ${bCases.length} 名`);
console.log(`\n★ 直していません。測定のみです。`);
