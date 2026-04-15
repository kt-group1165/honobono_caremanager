-- 041: 支援経過スマホURL用トークン + 匿名アクセスRLS

-- トークンテーブル
CREATE TABLE IF NOT EXISTS kaigo_support_tokens (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  token UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE kaigo_support_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_all" ON kaigo_support_tokens FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "anon_select" ON kaigo_support_tokens FOR SELECT TO anon USING (true);

-- 支援経過テーブルに匿名アクセス許可（閲覧+追加）
CREATE POLICY "anon_select_support" ON kaigo_support_records FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_support" ON kaigo_support_records FOR INSERT TO anon WITH CHECK (true);

-- kaigo_users と kaigo_care_plans も匿名読み取り許可（スマホで選択UI用）
CREATE POLICY "anon_select_users_for_support" ON kaigo_users FOR SELECT TO anon USING (true);
