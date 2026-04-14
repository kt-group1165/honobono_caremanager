-- 034: 訪問記録テーブルの拡張（SpO2追加 + 匿名書き込みRLSポリシー）

-- SpO2 列を追加
ALTER TABLE kaigo_visit_records ADD COLUMN IF NOT EXISTS vital_spo2 INTEGER;

-- 申し送り列を追加
ALTER TABLE kaigo_visit_records ADD COLUMN IF NOT EXISTS handover_notes TEXT;

-- schedule_id列（どのスケジュールに対する記録か紐付け）
ALTER TABLE kaigo_visit_records ADD COLUMN IF NOT EXISTS schedule_id UUID REFERENCES kaigo_visit_schedule(id);

-- 匿名ユーザー（職員トークンURL）からの書き込みを許可するRLSポリシー
-- anon ロールに対して INSERT/UPDATE/SELECT を許可
CREATE POLICY "anon_insert_visit_records" ON kaigo_visit_records FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_visit_records" ON kaigo_visit_records FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_select_visit_records" ON kaigo_visit_records FOR SELECT TO anon USING (true);
