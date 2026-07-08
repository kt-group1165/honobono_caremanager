import { StatsContent } from "./stats-content";

/**
 * /billing-visit/stats — 請求統計 (訪問介護)
 * ほのぼの「請求統計 (月遅れ・返戻者一覧)」相当。
 * 期間指定で 月遅れ・返戻者一覧 (kaigo_billing_status) と
 * 月次推移 (riyou_seikyu_payments 集計) を表示する。
 */
export default function BillingStatsPage() {
  return <StatsContent />;
}
