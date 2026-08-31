import { ComplianceContent } from "./compliance-content";

// 体制整備の記録 (委員会・指針・研修・訓練・担当者選任)
//   2026-09-01 監査是正で新設。虐待防止 / BCP の 1% + 1% 減算の立証に直結する。
//   分野 (虐待防止 / 身体拘束 / 感染症 / BCP / ハラスメント) を 1 画面に統合した。
//   保存先: migrations/compliance_records_v1.sql (kaigo_compliance_records)
//
// 事業所単位の台帳なので利用者サイドバーは出さない。
// 一覧・登録は client 側で行うためサーバ側の事前取得は無し。
export default function CompliancePage() {
  return (
    <div className="flex h-full -m-6">
      <ComplianceContent />
    </div>
  );
}
