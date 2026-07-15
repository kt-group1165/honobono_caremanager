-- bath_shift_v1 : 訪問入浴 シフト管理 (号車×日 ルート方式)
-- Phase: 訪問入浴版 第2弾シフト (user 確定 2026-07-15)
--
-- 設計 (専用ソフト型 = 入浴車(号車)×日 にコマを割り当てる方式。日立 福祉の森/ワイズマンSP と同型):
--   kaigo_bath_teams      : 号車 (チーム) マスタ。事業所単位。
--   kaigo_bath_team_days  : 号車×日の当日編成 (看1+介2 の 3 名を staff_ids[] で)。
--                           看護職員が居ない日は実績反映時に staff_only(減算) を自動セット。
--   kaigo_bath_patterns   : 利用者の週間パターン (曜日→号車・時刻)。月間一括生成の元。
--   kaigo_bath_schedule   : 予定コマ。visit_order で号車内の訪問順 (=ルート)。
--                           実績反映で kaigo_bath_visit_records に INSERT し record_id で 1:1 リンク
--                           (訪問介護の「同一キー一致で DELETE」方式の巻き込み事故を避けるため FK 参照にする)。
--   職員=members / 利用者=clients (共有マスタ)。RLS は他 kaigo テーブルと同じ authenticated_all。
--
-- Supabase SQL Editor に貼って実行 (BEGIN/COMMIT 入り)。

BEGIN;

-- 1. 号車マスタ
CREATE TABLE IF NOT EXISTS kaigo_bath_teams (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   TEXT NOT NULL DEFAULT 'kt-group',
  office_id   UUID NOT NULL,                        -- 訪問入浴事業所 (offices.id)
  name        TEXT NOT NULL,                        -- 例: 1号車
  vehicle_note TEXT,                                -- 車両ナンバー・ボイラー等のメモ
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kaigo_bath_teams_office ON kaigo_bath_teams(office_id, sort_order);

-- 2. 号車×日 の当日編成
CREATE TABLE IF NOT EXISTS kaigo_bath_team_days (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   TEXT NOT NULL DEFAULT 'kt-group',
  team_id     UUID NOT NULL REFERENCES kaigo_bath_teams(id) ON DELETE CASCADE,
  work_date   DATE NOT NULL,
  staff_ids   UUID[] NOT NULL DEFAULT '{}',         -- 当日メンバー (members.id、看1+介2 想定)
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (team_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_kaigo_bath_team_days_date ON kaigo_bath_team_days(work_date);

-- 3. 利用者の週間パターン
CREATE TABLE IF NOT EXISTS kaigo_bath_patterns (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   TEXT NOT NULL DEFAULT 'kt-group',
  office_id   UUID,                                 -- 訪問入浴事業所 (offices.id)
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),  -- 0=日..6=土
  start_time  TIME,
  end_time    TIME,
  team_id     UUID REFERENCES kaigo_bath_teams(id) ON DELETE SET NULL,
  bath_type   TEXT NOT NULL DEFAULT '全身浴' CHECK (bath_type IN ('全身浴', '部分浴')),
  scheme      TEXT NOT NULL DEFAULT '介護保険' CHECK (scheme IN ('介護保険', '地域生活支援')),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kaigo_bath_patterns_client ON kaigo_bath_patterns(client_id);
CREATE INDEX IF NOT EXISTS idx_kaigo_bath_patterns_office ON kaigo_bath_patterns(office_id);

-- 4. 予定コマ (号車×日×訪問順 = ルート)
CREATE TABLE IF NOT EXISTS kaigo_bath_schedule (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   TEXT NOT NULL DEFAULT 'kt-group',
  office_id   UUID,                                 -- 訪問入浴事業所 (offices.id)
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  team_id     UUID REFERENCES kaigo_bath_teams(id) ON DELETE SET NULL,  -- NULL=未割当
  visit_date  DATE NOT NULL,
  start_time  TIME,
  end_time    TIME,
  visit_order INTEGER NOT NULL DEFAULT 0,           -- 号車内の訪問順
  bath_type   TEXT NOT NULL DEFAULT '全身浴' CHECK (bath_type IN ('全身浴', '部分浴')),
  scheme      TEXT NOT NULL DEFAULT '介護保険' CHECK (scheme IN ('介護保険', '地域生活支援')),
  pattern_id  UUID REFERENCES kaigo_bath_patterns(id) ON DELETE SET NULL,  -- 生成元パターン
  status      TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  record_id   UUID REFERENCES kaigo_bath_visit_records(id) ON DELETE SET NULL,  -- 実績反映で作成した記録
  cancel_reason TEXT,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kaigo_bath_schedule_date   ON kaigo_bath_schedule(visit_date);
CREATE INDEX IF NOT EXISTS idx_kaigo_bath_schedule_team   ON kaigo_bath_schedule(team_id, visit_date);
CREATE INDEX IF NOT EXISTS idx_kaigo_bath_schedule_client ON kaigo_bath_schedule(client_id, visit_date);
CREATE INDEX IF NOT EXISTS idx_kaigo_bath_schedule_office ON kaigo_bath_schedule(office_id, visit_date);

-- updated_at トリガー
CREATE TRIGGER update_kaigo_bath_teams_updated_at
  BEFORE UPDATE ON kaigo_bath_teams
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_kaigo_bath_team_days_updated_at
  BEFORE UPDATE ON kaigo_bath_team_days
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_kaigo_bath_patterns_updated_at
  BEFORE UPDATE ON kaigo_bath_patterns
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_kaigo_bath_schedule_updated_at
  BEFORE UPDATE ON kaigo_bath_schedule
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS
ALTER TABLE kaigo_bath_teams     ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_bath_team_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_bath_patterns  ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_bath_schedule  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_all" ON kaigo_bath_teams     FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON kaigo_bath_team_days FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON kaigo_bath_patterns  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON kaigo_bath_schedule  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
