/**
 * `report_month` ("YYYY-MM") から 月初 / 月末 の日付を出す。
 *
 * ⚠ `kaigo_report_documents` は **月単位**で持っていて、
 *   `period_start` / `period_end` という列は **存在しない**。
 *   提供票の画面は期間を 2 つ表示するので、月から導出する。
 *
 * ⚠ `toISOString()` は UTC に寄るので JST で前日になる。文字列で組む
 *   (memory: feedback_toisostring_jst_offset)。
 */
export function monthStart(reportMonth: string | null): string | null {
  if (!reportMonth || !/^\d{4}-\d{2}$/.test(reportMonth)) return null;
  return `${reportMonth}-01`;
}

export function monthEnd(reportMonth: string | null): string | null {
  if (!reportMonth || !/^\d{4}-\d{2}$/.test(reportMonth)) return null;
  const y = Number(reportMonth.slice(0, 4));
  const m = Number(reportMonth.slice(5, 7));
  if (m < 1 || m > 12) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${reportMonth}-${String(last).padStart(2, "0")}`;
}
