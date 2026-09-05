/**
 * 「利用者の現在有効なケアプラン」を選ぶロジック — 純関数として切り出し (2026-09-05・B-6e相当)
 *
 * 元は下記3箇所にそれぞれ別々に (DBクエリ or インラインJS) 埋め込まれていた:
 *   - src/app/(authenticated)/reports/[type]/reports-content.tsx (第1表/第2表/第3表)
 *       `.eq("status","active").order("start_date",desc).limit(1)`
 *   - src/app/(authenticated)/monitoring/page.tsx (モニタリングシート)
 *       `plans.find(p => p.status === "active")?.id ?? plans[0]?.id ?? null`
 *   - src/app/(authenticated)/support-records/page.tsx (支援経過)
 *       同上
 *
 * ⚠⚠⚠ 既知の欠陥 (2026-09-05 実データで確認・H割当) ⚠⚠⚠
 *   どちらの選び方も **end_date (計画の有効期間終了日) を一切見ない**。
 *   status='active' な行の中で start_date が最も新しいものを無条件に選ぶため、
 *   「期限切れの計画」と「現在有効な計画」が両方あるとき、start_date が新しい方が
 *   選ばれる — それが期限切れであっても。
 *   → 直さない (今回は測るだけ・user 判断待ち)。直すときはこのファイルのコメントと
 *     scripts/careplan-selection-sample-verify.mts を更新すること。
 *
 * reports 側と monitoring/support-records 側で「statusを絞る/絞らない」が違う点も注意:
 *   - reports: status !== 'active' な行 (例: 'completed') は最初から存在しないものとして扱う
 *     → 該当が0件なら「計画が無い」と判定し、空の新規プランを自動生成する
 *   - monitoring/support-records: status を問わず1件でもあれば「計画が無い」にはならない
 *     (active が無ければ最新のものにフォールバックする)
 */

export interface CarePlanForSelection {
  id: string;
  status: string | null;
  start_date: string | null; // YYYY-MM-DD。null は「最も古い」扱い (実データでは通常入る)
}

const cmpStartDate = (a: string | null, b: string | null): number => (a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0;

/**
 * reports-content.tsx の元クエリ `.eq("status","active").order("start_date",desc).limit(1)`
 * と同じ結果を返す (順不同の配列を受け取ってよい)。
 * status==='active' が1件も無ければ null (呼出側はこれを「計画が無い」として扱い、
 * 空の新規プランを自動生成する)。
 */
export function selectCurrentPlanForReports(plans: CarePlanForSelection[]): CarePlanForSelection | null {
  const active = plans.filter((p) => p.status === "active");
  if (active.length === 0) return null;
  return active.reduce((latest, p) => (cmpStartDate(p.start_date, latest.start_date) > 0 ? p : latest));
}

/**
 * monitoring/page.tsx・support-records/page.tsx の元ロジック
 * `plans.find(p => p.status === "active") ?? plans[0] ?? null` と同じ結果を返す。
 * ⚠ 呼出側は plans を start_date 降順で渡すこと (元コードは DB の order() でこれを保証していた)。
 */
export function selectCurrentPlanWithFallback(plansOrderedByStartDateDesc: CarePlanForSelection[]): CarePlanForSelection | null {
  return plansOrderedByStartDateDesc.find((p) => p.status === "active") ?? plansOrderedByStartDateDesc[0] ?? null;
}

/**
 * monitoring-content.tsx の「今月未登録」警告の判定を切り出したもの (2026-09-05)。
 * 元は `sheets.some((s) => (s.monitoring_date ?? "").startsWith(thisMonth))` で、
 * thisMonth は呼出側で `format(new Date(), "yyyy-MM")` として渡す (このファイルは
 * 日付そのものに依存しないよう thisMonth を引数で受け取る)。
 */
export function hasMonitoringInMonth(sheets: { monitoring_date: string | null }[], thisMonth: string): boolean {
  return sheets.some((s) => (s.monitoring_date ?? "").startsWith(thisMonth));
}
