-- 043: 記録の定型文テンプレート
CREATE TABLE IF NOT EXISTS kaigo_record_templates (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  category TEXT NOT NULL,        -- 'visit_record' | 'support_record' | 'common'
  label TEXT NOT NULL,           -- 表示名（例: "体調安定"）
  content TEXT NOT NULL,         -- 挿入する本文
  sort_order INTEGER DEFAULT 0,  -- 並び順
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kaigo_record_templates_category ON kaigo_record_templates(category);

ALTER TABLE kaigo_record_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_all" ON kaigo_record_templates FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "anon_select" ON kaigo_record_templates FOR SELECT TO anon USING (true);

-- サンプル定型文
INSERT INTO kaigo_record_templates (category, label, content, sort_order) VALUES
  ('common', '体調安定', '体調安定。特に変化なし。', 10),
  ('common', '機嫌よく過ごす', '機嫌よくお過ごしでした。', 20),
  ('common', '食事全量摂取', '食事全量摂取されました。', 30),
  ('visit_record', '排便あり', '排便あり。性状普通。', 40),
  ('visit_record', '水分摂取良好', '水分摂取良好。お茶200ml摂取。', 50),
  ('visit_record', '入浴拒否', '入浴の声かけをするも拒否あり。清拭にて対応。', 60),
  ('support_record', 'モニタリング訪問', '定期モニタリング訪問。サービス状況確認。', 70),
  ('support_record', 'ご家族と連絡', 'ご家族に連絡し現状報告。', 80)
ON CONFLICT DO NOTHING;
