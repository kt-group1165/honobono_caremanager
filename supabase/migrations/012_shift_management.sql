-- =============================================
-- 訪問介護シフト管理テーブル
-- =============================================

-- 1. 利用者パターン（週間テンプレート）
CREATE TABLE kaigo_visit_patterns (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id) ON DELETE CASCADE,
  pattern_name TEXT NOT NULL DEFAULT 'パターン1', -- パターン1, パターン2...
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=日, 1=月...6=土
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  staff_id UUID REFERENCES kaigo_staff(id),
  service_type TEXT NOT NULL DEFAULT '身体介護' CHECK (service_type IN ('身体介護', '生活援助', '身体・生活', '通院等乗降介助')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_kaigo_visit_patterns_user ON kaigo_visit_patterns(user_id);

-- 2. 職員勤務可能ベース（恒久的な週間パターン）
CREATE TABLE kaigo_staff_availability_base (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  staff_id UUID NOT NULL REFERENCES kaigo_staff(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (staff_id, day_of_week, start_time)
);

CREATE INDEX idx_kaigo_staff_avail_base_staff ON kaigo_staff_availability_base(staff_id);

-- 3. 職員勤務可能（月次・該当月の実際の可否）
CREATE TABLE kaigo_staff_availability_monthly (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  staff_id UUID NOT NULL REFERENCES kaigo_staff(id) ON DELETE CASCADE,
  available_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  is_available BOOLEAN NOT NULL DEFAULT TRUE, -- FALSE=休み
  source TEXT DEFAULT 'base' CHECK (source IN ('base', 'manual')), -- base=ベースからコピー, manual=手動変更
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (staff_id, available_date, start_time)
);

CREATE INDEX idx_kaigo_staff_avail_monthly_staff ON kaigo_staff_availability_monthly(staff_id);
CREATE INDEX idx_kaigo_staff_avail_monthly_date ON kaigo_staff_availability_monthly(available_date);

-- 4. 訪問予定（月間の実際のスケジュール）
CREATE TABLE kaigo_visit_schedule (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id) ON DELETE CASCADE,
  staff_id UUID REFERENCES kaigo_staff(id),
  visit_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  service_type TEXT NOT NULL DEFAULT '身体介護',
  pattern_id UUID REFERENCES kaigo_visit_patterns(id), -- どのパターンから生成されたか
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled', 'changed')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_kaigo_visit_schedule_user ON kaigo_visit_schedule(user_id);
CREATE INDEX idx_kaigo_visit_schedule_staff ON kaigo_visit_schedule(staff_id);
CREATE INDEX idx_kaigo_visit_schedule_date ON kaigo_visit_schedule(visit_date);

-- 5. 職員申告用トークン（URL発行用）
CREATE TABLE kaigo_staff_tokens (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  staff_id UUID NOT NULL REFERENCES kaigo_staff(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ, -- NULL=無期限
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (staff_id)
);

-- トリガー
CREATE TRIGGER update_kaigo_visit_patterns_updated_at BEFORE UPDATE ON kaigo_visit_patterns FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_kaigo_visit_schedule_updated_at BEFORE UPDATE ON kaigo_visit_schedule FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS
ALTER TABLE kaigo_visit_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_staff_availability_base ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_staff_availability_monthly ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_visit_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_staff_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_all" ON kaigo_visit_patterns FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON kaigo_staff_availability_base FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON kaigo_staff_availability_monthly FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON kaigo_visit_schedule FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON kaigo_staff_tokens FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 職員トークンは匿名アクセスも許可（ログイン不要で勤務可能入力するため）
CREATE POLICY "anon_read_token" ON kaigo_staff_tokens FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_avail_base" ON kaigo_staff_availability_base FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_read_avail_monthly" ON kaigo_staff_availability_monthly FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_read_staff" ON kaigo_staff FOR SELECT TO anon USING (true);
