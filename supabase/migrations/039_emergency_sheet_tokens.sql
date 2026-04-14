-- 039: 緊急時シート用トークン + 安否確認テーブル

-- トークンテーブル（URL発行用）
CREATE TABLE IF NOT EXISTS kaigo_emergency_tokens (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  token UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  name TEXT NOT NULL,                -- 発行名（例: "災害時用"）
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE kaigo_emergency_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_all" ON kaigo_emergency_tokens FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "anon_select" ON kaigo_emergency_tokens FOR SELECT TO anon USING (true);

-- 安否確認・サービス調整テーブル
CREATE TABLE IF NOT EXISTS kaigo_emergency_status (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id) ON DELETE CASCADE,
  token_id UUID REFERENCES kaigo_emergency_tokens(id),
  safety_status TEXT DEFAULT '',      -- 安否確認: ◯/△/×
  service_status TEXT DEFAULT '',     -- サービス調整: ◯/△/×
  notes TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, token_id)
);

ALTER TABLE kaigo_emergency_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_all" ON kaigo_emergency_status FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON kaigo_emergency_status FOR ALL TO anon USING (true) WITH CHECK (true);

-- 緊急時シートもanon読み取り許可（スマホ閲覧用）
CREATE POLICY "anon_select_sheets" ON kaigo_emergency_sheets FOR SELECT TO anon USING (true);
