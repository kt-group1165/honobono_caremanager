/**
 * 訪問介護計画書の 未作成/期限切れ アラート (houmon-care-plan/plan-alert.ts) の
 * 純関数部分の検証 (DB 不使用)
 *
 *   npx tsx scripts/houmon-plan-alert-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   認定期限アラート(cert-expiry-alert.ts)・障害受給者証アラート
 *   (shogai-cert-expiry-alert.ts) と同じ「気づく仕組み」の一員だが、
 *   これまで検証されていなかった。ここは元から resolvePlanState/toAlerts/
 *   buildHoumonPlanAlertMessage/isHoumonPlanAlertNotification が export 済みの
 *   純関数なので抽出は不要 (他の2つと違う点)。
 *
 *   ★ 冒頭コメントにある「none (未作成) は通知しない」という設計上の非対称性
 *   (運営指導の指摘対象になりうる計画未作成を、通知だけ意図的に出さない)は
 *   壊れやすい。toAlerts はnoneも一覧向けに返すが、syncの側(notifiable、
 *   plan-alert.ts内の非export関数)で除外される。ここでは export された
 *   toAlerts の並び・stage付与と、buildHoumonPlanAlertMessageのnone分岐が
 *   正しいことまでを検証する(non-exportのnotifiableはtoAlertsの結果から
 *   自明に導かれる薄いフィルタなので、抽出コストに見合わず対象外とした)。
 */
import {
  resolvePlanState,
  toAlerts,
  buildHoumonPlanAlertMessage,
  isHoumonPlanAlertNotification,
  HOUMON_PLAN_ALERT_TYPES,
  HOUMON_PLAN_REF_TABLE,
  type LatestPlan,
  type PlanStateRow,
  type HoumonPlanAlert,
} from "@/lib/houmon-care-plan/plan-alert";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

const plan = (o: Partial<LatestPlan> & { id: string }): LatestPlan => ({
  user_id: "c1",
  plan_kind: "初回",
  plan_date: "2026-01-01",
  valid_until: null,
  status: "completed",
  ...o,
});

const todayIso = "2026-06-15";
const soonLimit = "2026-07-15"; // today + 30日

// ── resolvePlanState: 状態境界 ───────────────────────────────────────────
eq("計画が無い → none", resolvePlanState(null, todayIso, soonLimit), "none");
eq("★ valid_until が今日の前日 → expired", resolvePlanState(plan({ id: "a", valid_until: "2026-06-14" }), todayIso, soonLimit), "expired");
eq("★ valid_until が今日ちょうど → expired ではない (soonに落ちる)", resolvePlanState(plan({ id: "a", valid_until: "2026-06-15" }), todayIso, soonLimit), "soon");
eq("★ valid_until が+30日ちょうど → soon (境界含む)", resolvePlanState(plan({ id: "a", valid_until: "2026-07-15" }), todayIso, soonLimit), "soon");
eq("★ valid_until が+31日 → soonでもexpiredでもない → statusで決まる(confirmed→ok)", resolvePlanState(plan({ id: "a", valid_until: "2026-07-16" }), todayIso, soonLimit), "ok");
eq("valid_until が未設定で status=draft → draft", resolvePlanState(plan({ id: "a", valid_until: null, status: "draft" }), todayIso, soonLimit), "draft");
eq("valid_until が未設定で status=confirmed → ok", resolvePlanState(plan({ id: "a", valid_until: null, status: "completed" }), todayIso, soonLimit), "ok");
eq("★ valid_until が遠い未来でも status=draft なら draft (期限だけで確定しない)", resolvePlanState(plan({ id: "a", valid_until: "2027-01-01", status: "draft" }), todayIso, soonLimit), "draft");
eq("★ valid_until が期限切れでも判定順は expired が draft より優先", resolvePlanState(plan({ id: "a", valid_until: "2026-06-01", status: "draft" }), todayIso, soonLimit), "expired");

// ── toAlerts: 抽出対象・stage付与・並び順 ────────────────────────────────
{
  const rows: PlanStateRow[] = [
    { clientId: "ok1", clientName: "確定済太郎", furigana: null, plan: plan({ id: "p-ok", valid_until: "2027-01-01" }), state: "ok", daysLeft: 200 },
    { clientId: "draft1", clientName: "下書き花子", furigana: null, plan: plan({ id: "p-draft", status: "draft" }), state: "draft", daysLeft: null },
    { clientId: "none1", clientName: "未作成次郎", furigana: null, plan: null, state: "none", daysLeft: null },
    { clientId: "exp1", clientName: "期限切れ三郎", furigana: null, plan: plan({ id: "p-exp1", valid_until: "2026-06-10" }), state: "expired", daysLeft: -5 },
    { clientId: "exp2", clientName: "期限切れ四郎", furigana: null, plan: plan({ id: "p-exp2", valid_until: "2026-06-01" }), state: "expired", daysLeft: -14 },
    { clientId: "soon1", clientName: "残り少五郎", furigana: null, plan: plan({ id: "p-soon1", valid_until: "2026-07-10" }), state: "soon", daysLeft: 25 },
    { clientId: "soon2", clientName: "残り少六郎", furigana: null, plan: plan({ id: "p-soon2", valid_until: "2026-06-20" }), state: "soon", daysLeft: 5 },
  ];
  const alerts = toAlerts(rows);
  eq("★ ok/draft は要対応から除外される (対象は none/expired/soon の3状態のみ)", alerts.length, 5);
  eq("★ 並び順: none が最優先", alerts[0].clientId, "none1");
  eq("★ 並び順: 次に expired、かつ expired 同士は valid_until 昇順(古く期限切れの方が先)", [alerts[1].clientId, alerts[2].clientId], ["exp2", "exp1"]);
  eq("★ 並び順: 最後に soon、かつ soon 同士は valid_until 昇順(近い方が先)", [alerts[3].clientId, alerts[4].clientId], ["soon2", "soon1"]);
  eq("stage は state と同じ値が付く", alerts.map((a) => a.stage), ["none", "expired", "expired", "soon", "soon"]);
}

// ── buildHoumonPlanAlertMessage ──────────────────────────────────────────
{
  const noneAlert: HoumonPlanAlert = { clientId: "c1", clientName: "山田花子", furigana: null, plan: null, state: "none", daysLeft: null, stage: "none" };
  const noneMsg = buildHoumonPlanAlertMessage(noneAlert);
  eq("none: タイトルに「未作成」を含む", noneMsg.title.includes("未作成"), true);
  eq("none: 本文に利用者名を含む", noneMsg.body.includes("山田花子"), true);
  eq("★ none: 本文に満了日を含まない (計画自体が無いため)", /\d+\/\d+/.test(noneMsg.body), false);

  const expiredAlert: HoumonPlanAlert = { clientId: "c2", clientName: "佐藤次郎", furigana: null, plan: plan({ id: "p1", valid_until: "2026-06-20" }), state: "expired", daysLeft: -5, stage: "expired" };
  const expiredMsg = buildHoumonPlanAlertMessage(expiredAlert);
  eq("expired: タイトルに「期限切れ」を含む", expiredMsg.title.includes("期限切れ"), true);
  eq("expired: タイトルに満了日 (M/D) を含む", expiredMsg.title.includes("6/20"), true);

  const soonAlert: HoumonPlanAlert = { clientId: "c3", clientName: "鈴木三郎", furigana: null, plan: plan({ id: "p2", valid_until: "2026-07-10" }), state: "soon", daysLeft: 25, stage: "soon" };
  const soonMsg = buildHoumonPlanAlertMessage(soonAlert);
  eq("soon: タイトルに残り日数を含む", soonMsg.title.includes("残25日"), true);
  eq("★ soon: daysLeft が null の場合は 0 日扱い (?? 0 のフォールバック)", buildHoumonPlanAlertMessage({ ...soonAlert, daysLeft: null }).title.includes("残0日"), true);
}

// ── isHoumonPlanAlertNotification ────────────────────────────────────────
for (const type of HOUMON_PLAN_ALERT_TYPES) {
  eq(`${type} + ref_idあり は true`, isHoumonPlanAlertNotification({ type, ref_table: HOUMON_PLAN_REF_TABLE, ref_id: "x" }), true);
}
eq("★ ref_id 無しは false", isHoumonPlanAlertNotification({ type: HOUMON_PLAN_ALERT_TYPES[0], ref_table: HOUMON_PLAN_REF_TABLE, ref_id: null }), false);
eq("★ 別の通知種別 (cert_expired 等) は false", isHoumonPlanAlertNotification({ type: "cert_expired", ref_table: HOUMON_PLAN_REF_TABLE, ref_id: "x" }), false);

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① soon の境界を <= から < にする壊れた実装 (ちょうど30日後を見逃す)
  const brokenState = (p: LatestPlan | null, today: string, soon: string): string => {
    if (!p) return "none";
    if (p.valid_until && p.valid_until < today) return "expired";
    if (p.valid_until && p.valid_until < soon) return "soon"; // ★ わざと < にする (正は <=)
    if (p.status === "draft") return "draft";
    return "ok";
  };
  const p1 = plan({ id: "a", valid_until: "2026-07-15" }); // ちょうど+30日
  const correct = resolvePlanState(p1, todayIso, soonLimit);
  const broken = brokenState(p1, todayIso, soonLimit);
  const detected1 = correct !== broken;
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: soon境界(<=)の違いを検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ soon境界を<=から<にする(ちょうど30日後を見逃す)バグを検出できる (正=${correct} / 壊れた版=${broken})`);

  // ② none (未作成) を通知対象に含めてしまう壊れた実装
  //    (冒頭コメント: 運用開始前は自事業所が丸ごと未作成になり通知が埋もれるため意図的に除外)
  const rows: PlanStateRow[] = [
    { clientId: "none1", clientName: "未作成太郎", furigana: null, plan: null, state: "none", daysLeft: null },
  ];
  const alerts = toAlerts(rows);
  const correctNotifiable = alerts.filter((a) => (a.stage === "expired" || a.stage === "soon") && a.plan !== null);
  const brokenNotifiable = alerts; // ★ none を除外し忘れる壊れた版 (stage絞り込みをしない)
  const detected2 = correctNotifiable.length !== brokenNotifiable.length;
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: none除外の有無を検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ 未作成(none)を通知対象に混入させるバグを検出できる (正=${correctNotifiable.length}件 / 壊れた版=${brokenNotifiable.length}件)`);
}

console.log(`\n訪問介護計画書アラート (純関数部分) の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
