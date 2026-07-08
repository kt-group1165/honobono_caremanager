-- ============================================================================
-- 月次情報の計画単位数 (区分支給限度基準内単位数) — ほのぼの月次情報の取込/手入力相当
-- ============================================================================
-- 2026-07-08。ケアマネの提供票別表由来の「自事業所分の計画単位数」を利用者×月で保持。
-- source: 'manual'=手入力 / 'careplan'=ケアプラン別表から取込 / 'copy'=前月複写
-- target_month は date (各月1日)。アプリは 'YYYY-MM-01' を送る。

BEGIN;

CREATE TABLE IF NOT EXISTS kaigo_monthly_plan_units (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL DEFAULT 'kt-group',
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  target_month  DATE NOT NULL,            -- 各月1日 (YYYY-MM-01)
  planned_units INT NOT NULL DEFAULT 0,   -- 区分支給限度基準内単位数 (自事業所分)
  source        TEXT NOT NULL DEFAULT 'manual',  -- manual / careplan / copy
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, target_month)
);

CREATE INDEX IF NOT EXISTS idx_monthly_plan_units_month
  ON kaigo_monthly_plan_units (target_month);

ALTER TABLE kaigo_monthly_plan_units ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kaigo_monthly_plan_units_all ON kaigo_monthly_plan_units;
CREATE POLICY kaigo_monthly_plan_units_all ON kaigo_monthly_plan_units
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
