-- 032_hospitalizations.sql
-- 入退院管理テーブル

CREATE TABLE kaigo_hospitalizations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id) ON DELETE CASCADE,
  hospital_name TEXT NOT NULL,          -- 入院先病院名
  department TEXT,                      -- 診療科・病棟
  admission_date DATE NOT NULL,         -- 入院日
  discharge_date DATE,                  -- 退院日（NULL=入院中）
  reason TEXT,                          -- 入院理由
  discharge_destination TEXT,           -- 退院先（自宅/施設/転院等）
  notes TEXT,                           -- 備考
  status TEXT NOT NULL DEFAULT 'admitted' CHECK (status IN ('admitted', 'discharged')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_kaigo_hospitalizations_user ON kaigo_hospitalizations(user_id);
CREATE INDEX idx_kaigo_hospitalizations_status ON kaigo_hospitalizations(status);

CREATE TRIGGER update_kaigo_hospitalizations_updated_at
  BEFORE UPDATE ON kaigo_hospitalizations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE kaigo_hospitalizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_all" ON kaigo_hospitalizations
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
