-- 介護ソフト DBスキーマ
-- テーブル名に kaigo_ プレフィックスを付与（既存プロジェクトとの共存のため）

-- 利用者基本情報
CREATE TABLE kaigo_users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  name_kana TEXT NOT NULL DEFAULT '',
  gender TEXT NOT NULL CHECK (gender IN ('男', '女')),
  birth_date DATE NOT NULL,
  blood_type TEXT CHECK (blood_type IN ('A', 'B', 'O', 'AB', '不明', NULL)),
  postal_code TEXT,
  address TEXT,
  phone TEXT,
  mobile_phone TEXT,
  email TEXT,
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  admission_date DATE,
  discharge_date DATE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'deceased')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 介護認定情報
CREATE TABLE kaigo_care_certifications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id) ON DELETE CASCADE,
  certification_number TEXT,
  care_level TEXT NOT NULL CHECK (care_level IN ('要支援1', '要支援2', '要介護1', '要介護2', '要介護3', '要介護4', '要介護5', '非該当', '申請中')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  certification_date DATE,
  insurer_number TEXT,
  insured_number TEXT,
  support_limit_amount INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'pending')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 医療保険
CREATE TABLE kaigo_medical_insurance (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id) ON DELETE CASCADE,
  insurance_type TEXT NOT NULL,
  insurer_number TEXT,
  insured_number TEXT,
  start_date DATE,
  end_date DATE,
  copay_rate NUMERIC NOT NULL DEFAULT 0.3,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ADL記録
CREATE TABLE kaigo_adl_records (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id) ON DELETE CASCADE,
  assessment_date DATE NOT NULL,
  eating INTEGER NOT NULL DEFAULT 0,
  transfer INTEGER NOT NULL DEFAULT 0,
  grooming INTEGER NOT NULL DEFAULT 0,
  toilet INTEGER NOT NULL DEFAULT 0,
  bathing INTEGER NOT NULL DEFAULT 0,
  mobility INTEGER NOT NULL DEFAULT 0,
  stairs INTEGER NOT NULL DEFAULT 0,
  dressing INTEGER NOT NULL DEFAULT 0,
  bowel INTEGER NOT NULL DEFAULT 0,
  bladder INTEGER NOT NULL DEFAULT 0,
  total_score INTEGER NOT NULL DEFAULT 0,
  assessor_name TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 既往歴
CREATE TABLE kaigo_medical_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id) ON DELETE CASCADE,
  disease_name TEXT NOT NULL,
  onset_date DATE,
  status TEXT NOT NULL DEFAULT '治療中' CHECK (status IN ('治療中', '経過観察', '完治', 'その他')),
  hospital TEXT,
  doctor TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 健康管理記録
CREATE TABLE kaigo_health_records (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id) ON DELETE CASCADE,
  record_date DATE NOT NULL,
  temperature NUMERIC,
  blood_pressure_sys INTEGER,
  blood_pressure_dia INTEGER,
  pulse INTEGER,
  weight NUMERIC,
  height NUMERIC,
  spo2 INTEGER,
  notes TEXT,
  recorder_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 親族・関係者
CREATE TABLE kaigo_family_contacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relationship TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  is_key_person BOOLEAN DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 職員
CREATE TABLE kaigo_staff (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  name_kana TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL,
  qualifications TEXT,
  email TEXT,
  phone TEXT,
  employment_type TEXT NOT NULL DEFAULT '常勤' CHECK (employment_type IN ('常勤', '非常勤', 'パート')),
  hire_date DATE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- シフト
CREATE TABLE kaigo_shifts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  staff_id UUID NOT NULL REFERENCES kaigo_staff(id) ON DELETE CASCADE,
  shift_date DATE NOT NULL,
  shift_type TEXT NOT NULL CHECK (shift_type IN ('早番', '日勤', '遅番', '夜勤', '休み', '有給', '公休')),
  start_time TIME,
  end_time TIME,
  break_minutes INTEGER DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (staff_id, shift_date)
);

-- ケアプラン
CREATE TABLE kaigo_care_plans (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id) ON DELETE CASCADE,
  plan_number INTEGER NOT NULL DEFAULT 1,
  plan_type TEXT NOT NULL DEFAULT '居宅サービス計画',
  start_date DATE NOT NULL,
  end_date DATE,
  long_term_goals TEXT,
  short_term_goals TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'completed', 'cancelled')),
  created_by UUID REFERENCES kaigo_staff(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ケアプランサービス内容
CREATE TABLE kaigo_care_plan_services (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  care_plan_id UUID NOT NULL REFERENCES kaigo_care_plans(id) ON DELETE CASCADE,
  service_type TEXT NOT NULL,
  service_content TEXT NOT NULL,
  frequency TEXT,
  provider TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- サービス実績
CREATE TABLE kaigo_service_records (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id) ON DELETE CASCADE,
  service_date DATE NOT NULL,
  service_type TEXT NOT NULL,
  start_time TIME,
  end_time TIME,
  staff_id UUID REFERENCES kaigo_staff(id),
  content TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 請求データ
CREATE TABLE kaigo_billing_records (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id) ON DELETE CASCADE,
  billing_month TEXT NOT NULL,
  service_type TEXT NOT NULL,
  total_units INTEGER NOT NULL DEFAULT 0,
  unit_price NUMERIC NOT NULL DEFAULT 0,
  total_amount NUMERIC NOT NULL DEFAULT 0,
  insurance_amount NUMERIC NOT NULL DEFAULT 0,
  copay_amount NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'paid')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 請求明細
CREATE TABLE kaigo_billing_details (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  billing_record_id UUID NOT NULL REFERENCES kaigo_billing_records(id) ON DELETE CASCADE,
  service_date DATE NOT NULL,
  service_code TEXT NOT NULL,
  service_name TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  amount NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- インデックス
CREATE INDEX idx_kaigo_users_status ON kaigo_users(status);
CREATE INDEX idx_kaigo_users_name_kana ON kaigo_users(name_kana);
CREATE INDEX idx_kaigo_care_certifications_user ON kaigo_care_certifications(user_id);
CREATE INDEX idx_kaigo_shifts_date ON kaigo_shifts(shift_date);
CREATE INDEX idx_kaigo_shifts_staff ON kaigo_shifts(staff_id);
CREATE INDEX idx_kaigo_service_records_date ON kaigo_service_records(service_date);
CREATE INDEX idx_kaigo_billing_records_month ON kaigo_billing_records(billing_month);
CREATE INDEX idx_kaigo_care_plans_user ON kaigo_care_plans(user_id);

-- updated_at 自動更新トリガー
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_kaigo_users_updated_at BEFORE UPDATE ON kaigo_users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_kaigo_care_certifications_updated_at BEFORE UPDATE ON kaigo_care_certifications FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_kaigo_medical_insurance_updated_at BEFORE UPDATE ON kaigo_medical_insurance FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_kaigo_staff_updated_at BEFORE UPDATE ON kaigo_staff FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_kaigo_care_plans_updated_at BEFORE UPDATE ON kaigo_care_plans FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_kaigo_billing_records_updated_at BEFORE UPDATE ON kaigo_billing_records FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS (Row Level Security) ポリシー
ALTER TABLE kaigo_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_care_certifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_medical_insurance ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_adl_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_medical_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_health_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_family_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_care_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_care_plan_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_service_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_billing_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_billing_details ENABLE ROW LEVEL SECURITY;

-- 認証済みユーザーに全操作を許可（自社内利用のため）
CREATE POLICY "authenticated_all" ON kaigo_users FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON kaigo_care_certifications FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON kaigo_medical_insurance FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON kaigo_adl_records FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON kaigo_medical_history FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON kaigo_health_records FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON kaigo_family_contacts FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON kaigo_staff FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON kaigo_shifts FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON kaigo_care_plans FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON kaigo_care_plan_services FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON kaigo_service_records FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON kaigo_billing_records FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON kaigo_billing_details FOR ALL TO authenticated USING (true) WITH CHECK (true);
