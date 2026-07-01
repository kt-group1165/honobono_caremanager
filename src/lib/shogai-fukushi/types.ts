/**
 * 障害福祉サービス 型定義
 *
 * 対応サービス種別:
 *   居宅介護 (身体介護 / 家事援助 / 通院等介助 / 通院等乗降介助)
 *   重度訪問介護
 *   行動援護
 *   同行援護
 */

export const SHOGAI_SERVICE_TYPES = [
  "居宅介護",
  "重度訪問介護",
  "行動援護",
  "同行援護",
] as const;
export type ShogaiServiceType = (typeof SHOGAI_SERVICE_TYPES)[number];

export const KYOTAKU_KAIGO_CATEGORIES = [
  "身体介護",
  "家事援助",
  "通院等介助 (身体介護あり)",
  "通院等介助 (身体介護なし)",
  "通院等乗降介助",
] as const;
export type KyotakuKaigoCategory = (typeof KYOTAKU_KAIGO_CATEGORIES)[number];

/** 障害支援区分 (1-6)。重度訪問介護は 4 以上、行動援護は 3 以上、居宅介護は原則 1 以上 */
export type DisabilityClass = 1 | 2 | 3 | 4 | 5 | 6;

export const DISABILITY_CATEGORIES = ["身体", "知的", "精神", "難病等"] as const;
export type DisabilityCategoryValue = (typeof DISABILITY_CATEGORIES)[number];

/** モニタリング頻度 (=月数)。障害支援区分ごとに標準値あり */
export function defaultMonitoringFrequency(cls: DisabilityClass): number {
  // 区分1-2 → 6ヶ月に 1 回、区分3-6 → 3ヶ月に 1 回 (施行規則を単純化)
  return cls <= 2 ? 6 : 3;
}

// ─────────────────────────────────────────────────────
// 受給者証
// ─────────────────────────────────────────────────────
export interface ShogaiRecipientCert {
  id: string;
  tenant_id: string;
  client_id: string;
  recipient_number: string | null;
  municipality_code: string | null;
  disability_category: DisabilityCategoryValue | null;
  disability_class: DisabilityClass | null;
  benefit_start_date: string | null;
  benefit_end_date: string | null;
  self_payment_limit: number;
  self_payment_percent: number;
  seiho_flag: boolean;
  soudan_office_name: string | null;
  soudan_manager_name: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShogaiBenefitAllocation {
  id: string;
  cert_id: string;
  service_type: ShogaiServiceType;
  monthly_units: number;
  monthly_minutes: number | null;
  notes: string | null;
}

// ─────────────────────────────────────────────────────
// サービスコード マスタ
// ─────────────────────────────────────────────────────
export interface ShogaiServiceCode {
  id: string;
  fiscal_year: number;
  service_type: ShogaiServiceType;
  service_category: string | null;
  code: string;
  name: string;
  unit_count: number;
  min_minutes: number | null;
  max_minutes: number | null;
  time_bracket: string | null;
  is_addon: boolean;
  is_active: boolean;
  notes: string | null;
}

// ─────────────────────────────────────────────────────
// 加算 (record 上の 1 加算 = { code, name, units })
// ─────────────────────────────────────────────────────
export interface RecordAddon {
  code: string;
  name: string;
  units: number;
}

// ─────────────────────────────────────────────────────
// サービス提供実績記録
// ─────────────────────────────────────────────────────
export type RecordStatus = "draft" | "confirmed" | "cancelled";

export interface ShogaiServiceRecord {
  id: string;
  tenant_id: string;
  office_id: string | null;
  client_id: string;
  cert_id: string | null;
  service_date: string;
  start_time: string | null;
  end_time: string | null;
  duration_minutes: number | null;
  service_type: ShogaiServiceType;
  service_category: string | null;
  service_code: string | null;
  unit_count: number | null;
  staff_id: string | null;
  staff_name_cached: string | null;
  addons: RecordAddon[];
  activities: string | null;
  client_condition: string | null;
  family_condition: string | null;
  handover_notes: string | null;
  status: RecordStatus;
  cancel_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// ─────────────────────────────────────────────────────
// サービス等利用計画書 (身体障害・知的障害・精神障害 対応 相談支援)
// ─────────────────────────────────────────────────────
export interface ShogaiServiceUsePlan {
  id: string;
  tenant_id: string;
  office_id: string | null;
  client_id: string;
  plan_no: number;
  created_date: string | null;
  effective_from: string | null;
  effective_until: string | null;
  user_wish: string | null;
  family_wish: string | null;
  overall_policy: string | null;
  long_term_goal: string | null;
  short_term_goal: string | null;
  weekly_schedule: Record<string, unknown> | null;
  monitoring_frequency: number | null;
  status: "draft" | "issued" | "archived";
  form_data: Record<string, unknown>;
  notes: string | null;
}

// ─────────────────────────────────────────────────────
// 月次サマリ (billing snapshot)
// ─────────────────────────────────────────────────────
export interface ShogaiMonthlySummary {
  id: string;
  office_id: string | null;
  client_id: string;
  fiscal_year: number;
  month: number;
  service_type: ShogaiServiceType;
  total_units: number;
  total_amount: number;
  user_payment: number;
  benefit_payment: number;
  record_count: number;
  detail: Record<string, unknown>;
  computed_at: string;
}
