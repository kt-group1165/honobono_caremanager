-- 職員トークンページからマイシフト表示のため、anon に kaigo_visit_schedule と kaigo_users の読取りを許可
CREATE POLICY "anon_read_visit_schedule" ON kaigo_visit_schedule FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_users" ON kaigo_users FOR SELECT TO anon USING (true);
