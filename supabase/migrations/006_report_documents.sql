-- 帳票文書（編集可能な保存済み帳票）
CREATE TABLE kaigo_report_documents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL, -- 'care-plan-1', 'care-plan-2', 'care-plan-3', 'service-usage', 'service-provision', 'face-sheet'
  title TEXT, -- 文書タイトル（例: 居宅サービス計画書（1）2026年4月）
  report_month TEXT, -- 対象月 'YYYY-MM'（利用票等で使用）
  care_plan_id UUID REFERENCES kaigo_care_plans(id), -- 関連ケアプラン
  content JSONB NOT NULL DEFAULT '{}', -- 帳票の全フィールドをJSON形式で保存
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed')),
  created_by TEXT, -- 作成者名
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_kaigo_report_documents_user ON kaigo_report_documents(user_id);
CREATE INDEX idx_kaigo_report_documents_type ON kaigo_report_documents(report_type);

CREATE TRIGGER update_kaigo_report_documents_updated_at BEFORE UPDATE ON kaigo_report_documents FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE kaigo_report_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_all" ON kaigo_report_documents FOR ALL TO authenticated USING (true) WITH CHECK (true);
