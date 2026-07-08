import { StatsContent } from "./stats-content";

/**
 * /billing/stats — 請求統計 (居宅介護支援)
 * billing-visit/stats (訪問介護版) の居宅版。
 * 期間指定で 月遅れ・返戻者一覧 (kaigo_billing_status) と
 * 月次推移 (kaigo_care_support_claims 集計 + kokuho_nyukin_records の入金状況) を表示する。
 */
export default function KyotakuBillingStatsPage() {
  return <StatsContent />;
}
