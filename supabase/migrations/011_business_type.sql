-- 事業種別
ALTER TABLE kaigo_office_settings ADD COLUMN IF NOT EXISTS business_type TEXT DEFAULT '居宅介護支援' CHECK (business_type IN ('居宅介護支援', '訪問介護', '通所介護'));

-- 訪問介護用テーブル

-- 職員（訪問介護用 - 既存kaigo_staffを共用）

-- シフト（既存kaigo_shiftsを共用）

-- サービス実施記録（訪問介護）
CREATE TABLE kaigo_visit_records (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id) ON DELETE CASCADE,
  visit_date DATE NOT NULL,
  staff_id UUID REFERENCES kaigo_staff(id),
  service_type TEXT NOT NULL CHECK (service_type IN ('身体介護', '生活援助', '身体・生活', '通院等乗降介助')),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  -- 実施内容チェックリスト
  body_care JSONB DEFAULT '{}', -- 排泄介助, 食事介助, 入浴介助, 清拭, 体位変換, 移動介助, 更衣介助, 口腔ケア, 服薬介助 等
  living_support JSONB DEFAULT '{}', -- 調理, 洗濯, 掃除, 買物, ゴミ出し, 衣類の整理 等
  -- 利用者の状態
  user_condition TEXT, -- 利用者の様子・状態
  vital_temperature NUMERIC,
  vital_bp_sys INTEGER,
  vital_bp_dia INTEGER,
  vital_pulse INTEGER,
  -- 特記事項
  notes TEXT,
  -- ステータス
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'submitted')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_kaigo_visit_records_user ON kaigo_visit_records(user_id);
CREATE INDEX idx_kaigo_visit_records_date ON kaigo_visit_records(visit_date);
CREATE INDEX idx_kaigo_visit_records_staff ON kaigo_visit_records(staff_id);

CREATE TRIGGER update_kaigo_visit_records_updated_at BEFORE UPDATE ON kaigo_visit_records FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE kaigo_visit_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_all" ON kaigo_visit_records FOR ALL TO authenticated USING (true) WITH CHECK (true);
