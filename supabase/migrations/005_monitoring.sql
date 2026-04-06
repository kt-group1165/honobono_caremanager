-- モニタリングシート
CREATE TABLE kaigo_monitoring_sheets (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id) ON DELETE CASCADE,
  monitoring_date DATE NOT NULL,
  care_plan_id UUID REFERENCES kaigo_care_plans(id),
  assessor_name TEXT, -- サービス計画書作成者
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- モニタリング項目（短期目標ごとに1行）
CREATE TABLE kaigo_monitoring_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  monitoring_sheet_id UUID NOT NULL REFERENCES kaigo_monitoring_sheets(id) ON DELETE CASCADE,
  item_number INTEGER NOT NULL DEFAULT 1,
  short_term_goal TEXT, -- 短期目標
  goal_period_start DATE, -- 期間（開始）
  goal_period_end DATE, -- 期間（終了）
  service_type TEXT, -- サービス種別
  provider_name TEXT, -- 事業所名
  implementation_status TEXT, -- 居宅サービス計画の実施状況・トラブル状況
  user_satisfaction TEXT CHECK (user_satisfaction IN ('満足', '不満', NULL)), -- 利用者満足
  family_satisfaction TEXT CHECK (family_satisfaction IN ('満足', '不満', NULL)), -- 家族満足
  satisfaction_comment TEXT, -- 利用者・家族の満足と意見
  achievement TEXT CHECK (achievement IN ('達成した', 'ほぼ達成', '未達成', NULL)), -- 達成度評価
  adl_change TEXT CHECK (adl_change IN ('良い変化', '不変', '悪化', NULL)), -- ADL・IADL変化
  plan_revision_needed BOOLEAN DEFAULT FALSE, -- プラン修正の必要性
  revision_reason TEXT, -- その理由/今後の方針・新たな目標
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- インデックス
CREATE INDEX idx_kaigo_monitoring_sheets_user ON kaigo_monitoring_sheets(user_id);
CREATE INDEX idx_kaigo_monitoring_sheets_date ON kaigo_monitoring_sheets(monitoring_date);
CREATE INDEX idx_kaigo_monitoring_items_sheet ON kaigo_monitoring_items(monitoring_sheet_id);

-- トリガー
CREATE TRIGGER update_kaigo_monitoring_sheets_updated_at BEFORE UPDATE ON kaigo_monitoring_sheets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS
ALTER TABLE kaigo_monitoring_sheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_monitoring_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_all" ON kaigo_monitoring_sheets FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON kaigo_monitoring_items FOR ALL TO authenticated USING (true) WITH CHECK (true);
