// 利用者基本情報
export type KaigoUser = {
  id: string;
  name: string;
  name_kana: string;
  gender: "男" | "女";
  birth_date: string;
  blood_type: string | null;
  postal_code: string | null;
  address: string | null;
  phone: string | null;
  mobile_phone: string | null;
  email: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  admission_date: string | null;
  discharge_date: string | null;
  status: "active" | "inactive" | "deceased";
  notes: string | null;
  created_at: string;
  updated_at: string;
};

// 介護認定情報
export type CareCertification = {
  id: string;
  user_id: string;
  certification_number: string | null;
  care_level: CareLevel;
  start_date: string;
  end_date: string;
  certification_date: string | null;
  insurer_number: string | null;
  insured_number: string | null;
  support_limit_amount: number | null;
  status: "active" | "expired" | "pending";
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

// 職員
export type Staff = {
  id: string;
  name: string;
  name_kana: string;
  role: string;
  qualifications: string | null;
  email: string | null;
  phone: string | null;
  employment_type: "常勤" | "非常勤" | "パート";
  hire_date: string | null;
  status: "active" | "inactive";
  created_at: string;
  updated_at: string;
};

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
