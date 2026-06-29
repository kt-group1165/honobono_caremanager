-- 訪問介護計画書 (kaigo_houmon_care_plans) schema (2026-06-29)
--
-- 法令: 厚労省指定基準 第28条「訪問介護計画の作成」
-- 訪問介護事業所が居宅ケアプランと別に利用者ごとに作成する計画書。
--
-- 1 row = 1 plan version (= 同一利用者で複数版を保持する想定、plan_date 降順表示)
--
-- ❗ Supabase SQL Editor で実行する場合は BEGIN; ... COMMIT; を 1 ブロックで貼って Run。
--    BEGIN; のみで COMMIT 忘れると auto-rollback される (= memory: feedback_supabase_sql_editor.md)

BEGIN;

CREATE TABLE IF NOT EXISTS kaigo_houmon_care_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  office_id UUID,                                -- 訪問介護事業所 (= 作成元)
  plan_date DATE NOT NULL,                       -- 計画作成日
  valid_from DATE,                               -- 有効期間 開始
  valid_until DATE,                              -- 有効期間 終了
  long_term_goal TEXT,                           -- 長期目標
  short_term_goal TEXT,                          -- 短期目標
  user_situation TEXT,                           -- 利用者の状況
  family_situation TEXT,                         -- 家族の状況
  services JSONB NOT NULL DEFAULT '[]'::jsonb,   -- サービス内容 (配列)
  -- services = [{ kind: "身体2", frequency: "週3回", time_range: "9:00-9:45", content: "..." }, ...]
  special_notes TEXT,                            -- 特記事項
  author_name TEXT,                              -- サービス提供責任者
  user_consent_date DATE,                        -- 利用者同意日
  user_consent_name TEXT,                        -- 利用者同意者名
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID
);

COMMENT ON TABLE kaigo_houmon_care_plans IS '訪問介護計画書 (指定基準 第28条)';
COMMENT ON COLUMN kaigo_houmon_care_plans.services IS
  'サービス内容 JSONB 配列: [{ kind, frequency, time_range, content }, ...]';

CREATE INDEX IF NOT EXISTS idx_kaigo_houmon_care_plans_user
  ON kaigo_houmon_care_plans(user_id);
CREATE INDEX IF NOT EXISTS idx_kaigo_houmon_care_plans_tenant
  ON kaigo_houmon_care_plans(tenant_id);
CREATE INDEX IF NOT EXISTS idx_kaigo_houmon_care_plans_office
  ON kaigo_houmon_care_plans(office_id);

ALTER TABLE kaigo_houmon_care_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS houmon_care_plans_auth ON kaigo_houmon_care_plans;
CREATE POLICY houmon_care_plans_auth ON kaigo_houmon_care_plans
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- updated_at trigger (= 共通 pattern)
CREATE OR REPLACE FUNCTION trg_kaigo_houmon_care_plans_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS kaigo_houmon_care_plans_updated_at ON kaigo_houmon_care_plans;
CREATE TRIGGER kaigo_houmon_care_plans_updated_at
  BEFORE UPDATE ON kaigo_houmon_care_plans
  FOR EACH ROW
  EXECUTE FUNCTION trg_kaigo_houmon_care_plans_updated_at();

COMMIT;
