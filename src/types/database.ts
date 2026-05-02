// 利用者基本情報（共通マスタ clients に統合済 - Phase 2-3-1）
//
// DB カラム名と TS フィールド名は同じ。kaigo_users 旧フィールドからの主な変更:
//   name_kana    → furigana
//   mobile_phone → mobile
//   notes        → client_memos テーブル（別管理）
//
// clients 全カラム（Phase 1-5 + Phase 2-0-05 追加分含む）を網羅。
export type Client = {
  id: string;
  tenant_id: string;
  user_number: string | null;
  name: string;
  furigana: string | null;
  // 連絡先
  phone: string | null;
  mobile: string | null;
  address: string | null;
  postal_code: string | null;
  email: string | null;
  // 個人属性
  gender: string | null;          // '男' | '女' | 'その他' | null
  blood_type: string | null;      // 'A' | 'B' | 'O' | 'AB' | '不明' | null
  birth_date: string | null;
  // 介護情報（認定情報の最新値キャッシュ）
  care_level: string | null;
  benefit_rate: string | null;
  insured_number: string | null;
  certification_start_date: string | null;
  certification_end_date: string | null;
  insurer_number: string | null;
  copay_rate: string | null;
  public_expense: string | null;
  // ケアマネ
  care_manager: string | null;
  care_manager_org: string | null;
  care_office_id: string | null;
  care_manager_id: string | null;
  referrer_org: string | null;
  // 緊急連絡先
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  // 入退所
  admission_date: string | null;
  discharge_date: string | null;
  // ステータス
  status: "active" | "inactive" | "deceased";
  is_facility: boolean;
  is_provisional: boolean;
  // メモ（旧、client_memos へ移行済。新規 INSERT は client_memos を使う）
  memo: string | null;
  // 削除
  deleted_at: string | null;
  // タイムスタンプ
  created_at: string;
  updated_at: string;
};

/** @deprecated Phase 2-3-1 で Client 型に統合。新規コードは Client を使う。 */
export type KaigoUser = Client;

// 介護認定情報（共通マスタ client_insurance_records に統合済 - Phase 2-3-3）
//
// kaigo_care_certifications 旧フィールドからの主な変更:
//   user_id              → client_id
//   start_date           → certification_start_date
//   end_date             → certification_end_date
//   support_limit_amount → service_limit_amount
//   status               → certification_status
//
// client_insurance_records は他にも多くのカラムを持つが、kaigo-app から必須参照する
// subset のみを type に含める（フィールドが必要になれば追加）。
export type CareCertification = {
  id: string;
  tenant_id: string;
  client_id: string;
  certification_number: string | null;
  care_level: string | null;          // CHECK 制約は共通側にまだ無い（Phase 2 後半でクリーンアップ後付与予定）
  certification_start_date: string | null;
  certification_end_date: string | null;
  certification_date: string | null;
  insurer_number: string | null;
  insured_number: string | null;
  service_limit_amount: number | null;
  certification_status: string | null;  // 共通側は値域自由（'active'|'expired'|'pending'|'認定済み'... 混在の可能性）
  created_at: string;
  updated_at: string;
};

export type CareLevel =
  | "要支援1"
  | "要支援2"
  | "要介護1"
  | "要介護2"
  | "要介護3"
  | "要介護4"
  | "要介護5"
  | "非該当"
  | "申請中";

// 医療保険
export type MedicalInsurance = {
  id: string;
  user_id: string;
  insurance_type: string;
  insurer_number: string | null;
  insured_number: string | null;
  start_date: string | null;
  end_date: string | null;
  copay_rate: number;
  created_at: string;
  updated_at: string;
};

// ADL記録
export type AdlRecord = {
  id: string;
  user_id: string;
  assessment_date: string;
  eating: number;
  transfer: number;
  grooming: number;
  toilet: number;
  bathing: number;
  mobility: number;
  stairs: number;
  dressing: number;
  bowel: number;
  bladder: number;
  total_score: number;
  assessor_name: string | null;
  notes: string | null;
  created_at: string;
};

// 既往歴
export type MedicalHistory = {
  id: string;
  user_id: string;
  disease_name: string;
  onset_date: string | null;
  status: "治療中" | "経過観察" | "完治" | "その他";
  hospital: string | null;
  doctor: string | null;
  notes: string | null;
  created_at: string;
};

// 健康管理記録
export type HealthRecord = {
  id: string;
  user_id: string;
  record_date: string;
  temperature: number | null;
  blood_pressure_sys: number | null;
  blood_pressure_dia: number | null;
  pulse: number | null;
  weight: number | null;
  height: number | null;
  spo2: number | null;
  notes: string | null;
  recorder_name: string | null;
  created_at: string;
};

// 親族・関係者
export type FamilyContact = {
  id: string;
  user_id: string;
  name: string;
  relationship: string;
  phone: string | null;
  address: string | null;
  is_key_person: boolean;
  notes: string | null;
  created_at: string;
};

// 職員（共通マスタ members に統合済 - Phase 2-3-2）
//
// DB カラム名と TS フィールド名は同じ。kaigo_staff 旧フィールドからの主な変更:
//   name_kana → furigana
//
// members 全カラム（Phase 2-0-07 追加分含む）を網羅。
export type Member = {
  id: string;
  tenant_id: string;
  name: string;
  furigana: string | null;
  // kaigo_staff 由来のカラム（Phase 2-0-07 で追加）
  role: string | null;
  qualifications: string | null;
  email: string | null;
  phone: string | null;
  employment_type: "常勤" | "非常勤" | "パート" | null;
  hire_date: string | null;
  status: "active" | "inactive";
  // order-app 専用 UI 設定（kaigo-app からは参照不要）
  color: string | null;
  sort_order: number | null;
  // タイムスタンプ
  created_at: string;
  updated_at: string;
};

/** @deprecated Phase 2-3-2 で Member 型に統合。新規コードは Member を使う。 */
export type Staff = Member;

// シフト
export type Shift = {
  id: string;
  staff_id: string;
  shift_date: string;
  shift_type: ShiftType;
  start_time: string | null;
  end_time: string | null;
  break_minutes: number;
  notes: string | null;
  created_at: string;
};

export type ShiftType = "早番" | "日勤" | "遅番" | "夜勤" | "休み" | "有給" | "公休";

// ケアプラン
export type CarePlan = {
  id: string;
  user_id: string;
  plan_number: number;
  plan_type: string;
  start_date: string;
  end_date: string | null;
  long_term_goals: string | null;
  short_term_goals: string | null;
  status: "draft" | "active" | "completed" | "cancelled";
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

// ケアプランサービス内容
export type CarePlanService = {
  id: string;
  care_plan_id: string;
  service_type: string;
  service_content: string;
  frequency: string | null;
  provider: string | null;
  notes: string | null;
  created_at: string;
};

// サービス実績
export type ServiceRecord = {
  id: string;
  user_id: string;
  service_date: string;
  service_type: string;
  start_time: string | null;
  end_time: string | null;
  staff_id: string | null;
  content: string | null;
  notes: string | null;
  created_at: string;
};

// 請求データ
export type BillingRecord = {
  id: string;
  user_id: string;
  billing_month: string;
  service_type: string;
  total_units: number;
  unit_price: number;
  total_amount: number;
  insurance_amount: number;
  copay_amount: number;
  status: "draft" | "submitted" | "paid";
  created_at: string;
  updated_at: string;
};

// 請求明細
export type BillingDetail = {
  id: string;
  billing_record_id: string;
  service_date: string;
  service_code: string;
  service_name: string;
  units: number;
  amount: number;
  created_at: string;
};
