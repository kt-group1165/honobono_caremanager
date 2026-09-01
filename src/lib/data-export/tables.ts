// ─── 全データエクスポート対象テーブル定義 ────────────────────────────────────
// 千葉県補助要綱 (医療情報システム安全管理ガイドラインの移行容易性) 対応:
// 「介護記録等のデータについては CSV/JSON 等、変換が容易なデータ形式で
//   出力・入力できる機能を備えていることが望ましい」への回答となる read-only 機能。
//
// 対象外 (意図的に除外):
//  - kaigo_service_codes / shogai_service_codes …… 国の標準サービスコードマスタ
//    (合計 23 万行超の公開マスタで、移行対象の「介護記録データ」ではない)
//  - kaigo_staff_tokens / kaigo_support_tokens / kaigo_emergency_tokens /
//    staff_invitations / trusted_devices …… 認証・招待トークン (漏えいリスクのみでデータ価値なし)
//  - kaigo_ai_usage_logs / tenants / user_offices …… 運用ログ・内部管理

/** 期間指定の絞り込み方法 */
export interface ExportTableFilter {
  /** 絞り込み列名 */
  column: string;
  /** date = 'YYYY-MM-DD' 列 / month = 'YYYY-MM' 文字列列 */
  kind: "date" | "month";
}

export interface ExportTable {
  /** Supabase テーブル名 */
  name: string;
  /** UI 表示名 */
  label: string;
  /** ページング時の安定ソート列 (省略時 ["id"]) */
  orderBy?: string[];
  /** 期間指定 (月範囲) に対応する場合の列定義。無いテーブルは常に全件 */
  filter?: ExportTableFilter;
}

export interface ExportTableGroup {
  group: string;
  tables: ExportTable[];
}

export const EXPORT_TABLE_GROUPS: ExportTableGroup[] = [
  {
    group: "利用者",
    tables: [
      { name: "clients", label: "利用者" },
      { name: "client_office_assignments", label: "利用者×事業所 割当" },
      { name: "client_insurance_records", label: "介護保険情報" },
      { name: "client_kohi_records", label: "公費情報" },
      // client_disability_certifications は 0 件のまま並存していた重複テーブル。
      // 受給者証は shougai_certifications に一本化 (2026-08-19)
      { name: "shougai_certifications", label: "障害支給決定 (受給者証)" },
      { name: "client_hospitalizations", label: "入退院情報" },
      { name: "client_memos", label: "利用者メモ" },
      { name: "kaigo_family_contacts", label: "家族・緊急連絡先" },
      { name: "kaigo_medical_history", label: "既往歴・医療情報" },
      { name: "kaigo_medical_insurance", label: "医療保険情報" },
      { name: "kaigo_health_records", label: "健康記録", filter: { column: "record_date", kind: "date" } },
      { name: "kaigo_adl_records", label: "ADL 記録" },
      { name: "kaigo_user_contracts", label: "利用者契約" },
      { name: "kaigo_emergency_sheets", label: "緊急時シート" },
      { name: "kaigo_emergency_status", label: "緊急時ステータス" },
    ],
  },
  {
    group: "事業所・職員",
    tables: [
      { name: "offices", label: "自事業所" },
      { name: "care_offices", label: "関係事業所" },
      { name: "kaigo_service_providers", label: "サービス提供事業所" },
      { name: "companies", label: "会社" },
      { name: "members", label: "職員" },
      { name: "member_offices", label: "職員×事業所 割当", orderBy: ["member_id", "office_id"] },
      { name: "kaigo_office_addon_periods", label: "事業所 加算期間" },
      { name: "kaigo_office_gensan_periods", label: "事業所 減算期間" },
    ],
  },
  {
    group: "居宅介護支援",
    tables: [
      { name: "kaigo_care_plans", label: "ケアプラン (居宅サービス計画書)" },
      { name: "kaigo_care_plan_services", label: "ケアプラン サービス行" },
      { name: "kaigo_assessments", label: "アセスメント" },
      { name: "kaigo_monitoring_sheets", label: "モニタリング", filter: { column: "monitoring_date", kind: "date" } },
      { name: "kaigo_monitoring_items", label: "モニタリング項目" },
      { name: "kaigo_support_records", label: "支援経過記録", filter: { column: "record_date", kind: "date" } },
      { name: "kaigo_care_conferences", label: "サービス担当者会議", filter: { column: "held_on", kind: "date" } },
      { name: "kaigo_report_documents", label: "帳票ドキュメント" },
      { name: "kaigo_benefit_management", label: "給付管理", filter: { column: "billing_month", kind: "month" } },
      { name: "kaigo_gendo_allocation", label: "限度額管理 配分", filter: { column: "target_month", kind: "month" } },
      { name: "kaigo_monthly_plan_units", label: "月間計画単位数", filter: { column: "target_month", kind: "month" } },
    ],
  },
  {
    group: "訪問介護",
    tables: [
      { name: "kaigo_visit_schedule", label: "訪問予定", filter: { column: "visit_date", kind: "date" } },
      { name: "kaigo_visit_records", label: "訪問記録 (実績)", filter: { column: "visit_date", kind: "date" } },
      { name: "kaigo_visit_patterns", label: "訪問パターン" },
      { name: "kaigo_visit_addon_lines", label: "実績単位 加算行", filter: { column: "target_month", kind: "month" } },
      { name: "kaigo_visit_month_addons", label: "月次加算", filter: { column: "target_month", kind: "month" } },
      { name: "kaigo_houmon_care_plans", label: "訪問介護計画書" },
      { name: "kaigo_visit_procedure_documents", label: "訪問介護手順書" },
      { name: "kaigo_visit_procedure_services", label: "手順書 サービス" },
      { name: "kaigo_visit_procedure_steps", label: "手順書 ステップ" },
      { name: "kaigo_visit_procedure_step_templates", label: "手順書 ステップ雛形" },
      { name: "kaigo_staff_availability_base", label: "勤務可能時間 (基本)" },
      { name: "kaigo_staff_availability_monthly", label: "勤務可能時間 (月別)", filter: { column: "available_date", kind: "date" } },
    ],
  },
  {
    group: "訪問入浴",
    tables: [
      { name: "kaigo_bath_visit_records", label: "入浴実施記録", filter: { column: "visit_date", kind: "date" } },
      { name: "bath_monthly_plan_units", label: "入浴 月間計画単位数", filter: { column: "target_month", kind: "month" } },
    ],
  },
  {
    group: "請求・入金",
    tables: [
      { name: "kaigo_billing_status", label: "請求ステータス (介護)", filter: { column: "target_month", kind: "month" } },
      { name: "kaigo_billing_records", label: "請求記録", filter: { column: "billing_month", kind: "month" } },
      { name: "kaigo_billing_details", label: "請求明細" },
      { name: "kaigo_billing_addons", label: "請求加算" },
      { name: "kaigo_care_support_claims", label: "居宅介護支援費 請求", filter: { column: "billing_month", kind: "month" } },
      { name: "riyou_seikyu_payments", label: "利用者請求 入金", filter: { column: "target_month", kind: "month" } },
      { name: "riyou_jippi_entries", label: "実費入力", filter: { column: "target_month", kind: "month" } },
      { name: "kaigo_riyou_settings", label: "利用者請求 設定" },
      { name: "kokuho_nyukin_records", label: "国保連 入金記録", filter: { column: "target_month", kind: "month" } },
      { name: "kokuho_shinsa_notice_files", label: "審査結果通知 ファイル" },
      { name: "kokuho_shinsa_notice_rows", label: "審査結果通知 行" },
    ],
  },
  {
    group: "障害福祉",
    tables: [
      { name: "shogai_service_records", label: "障害 サービス実績", filter: { column: "service_date", kind: "date" } },
      { name: "shogai_billing_status", label: "障害 請求ステータス", filter: { column: "target_month", kind: "month" } },
      { name: "shogai_seikyu_payments", label: "障害 請求入金", filter: { column: "target_month", kind: "month" } },
      { name: "shogai_jogen_kanri_results", label: "障害 上限管理結果", filter: { column: "target_month", kind: "month" } },
    ],
  },
  {
    group: "テンプレート・その他",
    tables: [
      { name: "kaigo_contract_templates", label: "契約書テンプレート" },
      { name: "kaigo_record_templates", label: "記録テンプレート" },
      { name: "bunrei_master", label: "文例マスタ" },
      { name: "shared_documents", label: "共有ドキュメント" },
      { name: "signatures", label: "電子署名" },
      { name: "notifications", label: "通知" },
      { name: "app_settings", label: "アプリ設定", orderBy: ["key"] },
    ],
  },
];

export const ALL_EXPORT_TABLES: ExportTable[] = EXPORT_TABLE_GROUPS.flatMap((g) => g.tables);
