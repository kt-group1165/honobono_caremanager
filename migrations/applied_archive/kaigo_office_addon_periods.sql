-- ============================================================================
-- 事業所の適用加算 (処遇改善等) の期間管理 — ほのぼの「事業所加算管理」の適用期間相当
-- ============================================================================
-- 2026-07-08。「5月まで処遇改善Ⅱ・6月からⅡ2」のような期中の区分変更を月単位で管理する。
-- 集計 (aggregate) は対象月でこのテーブルを引き、該当が無ければ従来の
-- offices.applied_formula_codes にフォールバックする。

BEGIN;

CREATE TABLE IF NOT EXISTS kaigo_office_addon_periods (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT NOT NULL DEFAULT 'kt-group',
  office_id    UUID NOT NULL,
  formula_code TEXT NOT NULL,        -- kaigo_service_codes.service_code (116274 等)
  start_month  TEXT,                 -- 'YYYY-MM' (NULL = 最初から)
  end_month    TEXT,                 -- 'YYYY-MM' (NULL = 無期限)
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_office_addon_periods_office
  ON kaigo_office_addon_periods (office_id, start_month);

ALTER TABLE kaigo_office_addon_periods ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kaigo_office_addon_periods_all ON kaigo_office_addon_periods;
CREATE POLICY kaigo_office_addon_periods_all ON kaigo_office_addon_periods
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
