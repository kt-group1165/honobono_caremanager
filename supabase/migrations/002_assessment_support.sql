-- アセスメント（居宅サービス計画ガイドライン）
CREATE TABLE kaigo_assessments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id) ON DELETE CASCADE,
  assessment_date DATE NOT NULL,
  assessor_name TEXT,

  -- 1. 家族状況・インフォーマルな支援
  family_situation TEXT,
  informal_support TEXT,

  -- 2. サービス利用状況
  current_services TEXT,

  -- 3. 住居等の状況
  housing_type TEXT,
  housing_situation TEXT,
  housing_issues TEXT,

  -- 4. 健康状態・受診等の状況
  health_condition TEXT,
  medical_visits TEXT,
  medications TEXT,

  -- 5. 基本動作等の状況・援助状況
  -- 移動
  mobility_status TEXT CHECK (mobility_status IN ('自立', '見守り', '一部介助', '全介助')),
  mobility_notes TEXT,
  -- 食事
  eating_status TEXT CHECK (eating_status IN ('自立', '見守り', '一部介助', '全介助')),
  eating_notes TEXT,
  -- 排泄
  toileting_status TEXT CHECK (toileting_status IN ('自立', '見守り', '一部介助', '全介助')),
  toileting_notes TEXT,
  -- 入浴
  bathing_status TEXT CHECK (bathing_status IN ('自立', '見守り', '一部介助', '全介助')),
  bathing_notes TEXT,
  -- 更衣
  dressing_status TEXT CHECK (dressing_status IN ('自立', '見守り', '一部介助', '全介助')),
  dressing_notes TEXT,
  -- 整容
  grooming_status TEXT CHECK (grooming_status IN ('自立', '見守り', '一部介助', '全介助')),
  grooming_notes TEXT,
  -- コミュニケーション
  communication_status TEXT CHECK (communication_status IN ('自立', '見守り', '一部介助', '全介助')),
  communication_notes TEXT,
  -- 認知
  cognition_status TEXT CHECK (cognition_status IN ('自立', '見守り', '一部介助', '全介助')),
  cognition_notes TEXT,

  -- 6. IADL
  cooking_status TEXT CHECK (cooking_status IN ('自立', '見守り', '一部介助', '全介助')),
  cleaning_status TEXT CHECK (cleaning_status IN ('自立', '見守り', '一部介助', '全介助')),
  laundry_status TEXT CHECK (laundry_status IN ('自立', '見守り', '一部介助', '全介助')),
  shopping_status TEXT CHECK (shopping_status IN ('自立', '見守り', '一部介助', '全介助')),
  money_management_status TEXT CHECK (money_management_status IN ('自立', '見守り', '一部介助', '全介助')),

  -- 7. 全体のまとめ
  user_request TEXT,
  family_request TEXT,
  overall_summary TEXT,
  issues TEXT,

  -- 8. 1日のスケジュール
  daily_schedule TEXT,

  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 支援経過記録
CREATE TABLE kaigo_support_records (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id) ON DELETE CASCADE,
  record_date DATE NOT NULL,
  record_time TIME,
  category TEXT NOT NULL CHECK (category IN ('電話', '訪問', '来所', 'メール', 'FAX', 'カンファレンス', 'サービス担当者会議', 'モニタリング', 'その他')),
  content TEXT NOT NULL,
  staff_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- インデックス
CREATE INDEX idx_kaigo_assessments_user ON kaigo_assessments(user_id);
CREATE INDEX idx_kaigo_assessments_date ON kaigo_assessments(assessment_date);
CREATE INDEX idx_kaigo_support_records_user ON kaigo_support_records(user_id);
CREATE INDEX idx_kaigo_support_records_date ON kaigo_support_records(record_date);

-- updated_at トリガー
CREATE TRIGGER update_kaigo_assessments_updated_at BEFORE UPDATE ON kaigo_assessments FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS
ALTER TABLE kaigo_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_support_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_all" ON kaigo_assessments FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON kaigo_support_records FOR ALL TO authenticated USING (true) WITH CHECK (true);
