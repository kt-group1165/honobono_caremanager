-- 給付管理票
CREATE TABLE kaigo_benefit_management (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id) ON DELETE CASCADE,
  billing_month TEXT NOT NULL, -- 'YYYY-MM'
  -- サービス種類ごとの単位数（各行がサービス種類）
  service_type TEXT NOT NULL,
  provider_name TEXT, -- サービス事業所名
  provider_number TEXT, -- 事業所番号
  planned_units INTEGER NOT NULL DEFAULT 0, -- 計画単位数
  actual_units INTEGER NOT NULL DEFAULT 0, -- 実績単位数（限度額管理対象）
  over_limit_units INTEGER NOT NULL DEFAULT 0, -- 限度額超過単位数
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'submitted')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, billing_month, service_type)
);

-- 居宅介護支援レセプト（介護給付費明細書）
CREATE TABLE kaigo_care_support_claims (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id) ON DELETE CASCADE,
  billing_month TEXT NOT NULL, -- 'YYYY-MM'
  -- 居宅介護支援費
  care_support_code TEXT NOT NULL DEFAULT '431000', -- サービスコード
  care_support_name TEXT NOT NULL DEFAULT '居宅介護支援費(i)', -- サービス名称
  units INTEGER NOT NULL DEFAULT 0, -- 単位数
  unit_price NUMERIC NOT NULL DEFAULT 10.00, -- 単位数単価（地域区分）
  total_amount INTEGER NOT NULL DEFAULT 0, -- 費用合計
  insurance_amount INTEGER NOT NULL DEFAULT 0, -- 保険請求額（10割給付）
  -- 加算
  initial_addition BOOLEAN DEFAULT FALSE, -- 初回加算
  initial_addition_units INTEGER DEFAULT 0,
  hospital_coordination BOOLEAN DEFAULT FALSE, -- 入院時情報連携加算
  hospital_coordination_units INTEGER DEFAULT 0,
  discharge_addition BOOLEAN DEFAULT FALSE, -- 退院・退所加算
  discharge_addition_units INTEGER DEFAULT 0,
  medical_coordination BOOLEAN DEFAULT FALSE, -- 通院時情報連携加算
  medical_coordination_units INTEGER DEFAULT 0,
  -- ステータス
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'submitted')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, billing_month)
);

-- インデックス
CREATE INDEX idx_kaigo_benefit_management_month ON kaigo_benefit_management(billing_month);
CREATE INDEX idx_kaigo_benefit_management_user ON kaigo_benefit_management(user_id);
CREATE INDEX idx_kaigo_care_support_claims_month ON kaigo_care_support_claims(billing_month);

-- トリガー
CREATE TRIGGER update_kaigo_benefit_management_updated_at BEFORE UPDATE ON kaigo_benefit_management FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_kaigo_care_support_claims_updated_at BEFORE UPDATE ON kaigo_care_support_claims FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS
ALTER TABLE kaigo_benefit_management ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_care_support_claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_all" ON kaigo_benefit_management FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON kaigo_care_support_claims FOR ALL TO authenticated USING (true) WITH CHECK (true);
