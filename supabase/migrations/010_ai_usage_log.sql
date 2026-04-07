-- AI使用ログ
CREATE TABLE kaigo_ai_usage_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES kaigo_users(id),
  user_name TEXT,
  action TEXT NOT NULL, -- 'care-plan-generate' etc
  mode TEXT, -- 'from-services', 'full'
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost NUMERIC NOT NULL DEFAULT 0, -- 円
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_kaigo_ai_usage_logs_date ON kaigo_ai_usage_logs(created_at);

ALTER TABLE kaigo_ai_usage_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_all" ON kaigo_ai_usage_logs FOR ALL TO authenticated USING (true) WITH CHECK (true);
