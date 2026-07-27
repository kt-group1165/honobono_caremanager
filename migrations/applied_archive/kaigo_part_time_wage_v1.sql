-- ============================================================================
-- パート職員 給与計算 v1 — サービス類型別 時給マスタ (事業所別)
-- ============================================================================
-- 2026-07-16。訪問介護のパート(時給制)職員の給与を、kaigo_visit_schedule
-- (status='completed' = 実績) の実働時間 × サービス類型別時給 で計算するための
-- 設定テーブル。payroll-app の payroll_service_categories / _category_hourly_rates /
-- _service_type_mappings と同方式だが、kaigo-app 側に独立して持つ (同 DB だが
-- JOIN 直参照はせず、各アプリ自己完結 = CLAUDE.md の snapshot-pull 設計に沿う)。
--
--   kaigo_wage_categories        … サービス類型 (名称 + 時給)。事業所ごと
--   kaigo_service_wage_mappings  … schedule.service_type の生値 → 類型 の割当
--
-- 実績の service_type は自由値 ("身体日１．０" "家事日１．０" "訪問型独自サービス11"
-- 等) なので、生値を類型 (身体介護/生活援助/独自 等) にまとめ、類型に時給を付ける。
--
-- Supabase SQL Editor に貼って Run。冪等 (IF NOT EXISTS)。
-- ============================================================================

BEGIN;

-- ── サービス類型 (時給の単位) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kaigo_wage_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id UUID NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                       -- 類型名 (身体介護 / 生活援助 / 通院 / 独自 / キャンセル 等)
  hourly_rate INTEGER NOT NULL DEFAULT 0,   -- 時給 (円/時)。給与計算は round(実働分/60 * hourly_rate)
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (office_id, name)
);

CREATE INDEX IF NOT EXISTS idx_kaigo_wage_categories_office
  ON kaigo_wage_categories (office_id);

DROP TRIGGER IF EXISTS trg_kaigo_wage_categories_updated_at ON kaigo_wage_categories;
CREATE TRIGGER trg_kaigo_wage_categories_updated_at
  BEFORE UPDATE ON kaigo_wage_categories
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE kaigo_wage_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_all" ON kaigo_wage_categories;
CREATE POLICY "authenticated_all" ON kaigo_wage_categories
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── サービス種類 (実績の service_type 生値) → 類型 の割当 ──────────────────────
CREATE TABLE IF NOT EXISTS kaigo_service_wage_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id UUID NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  service_type TEXT NOT NULL,               -- kaigo_visit_schedule.service_type の生値
  category_id UUID REFERENCES kaigo_wage_categories(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (office_id, service_type)
);

CREATE INDEX IF NOT EXISTS idx_kaigo_service_wage_mappings_office
  ON kaigo_service_wage_mappings (office_id);

DROP TRIGGER IF EXISTS trg_kaigo_service_wage_mappings_updated_at ON kaigo_service_wage_mappings;
CREATE TRIGGER trg_kaigo_service_wage_mappings_updated_at
  BEFORE UPDATE ON kaigo_service_wage_mappings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE kaigo_service_wage_mappings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_all" ON kaigo_service_wage_mappings;
CREATE POLICY "authenticated_all" ON kaigo_service_wage_mappings
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;

-- 確認:
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_name IN ('kaigo_wage_categories','kaigo_service_wage_mappings')
--  ORDER BY table_name, ordinal_position;
--
-- ロールバック:
-- DROP TABLE IF EXISTS kaigo_service_wage_mappings;
-- DROP TABLE IF EXISTS kaigo_wage_categories;
