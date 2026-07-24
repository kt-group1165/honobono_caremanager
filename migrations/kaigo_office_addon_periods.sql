-- ============================================================================
-- 処遇改善加算 区分の「期中切替」テーブル
-- ============================================================================
-- 2026-07-24。処遇改善加算の区分は事業所ごと・期間ごとに変わる (令和8年6月改定で
-- 訪問介護Ⅱ→Ⅱ²、障害 居宅介護Ⅱ→Ⅱロ 等)。applied_formula_codes は単一設定しか
-- 持てないため、期間付きで区分 (= service_code) を保持するこのテーブルで解決する。
--
-- 集計 (visit-seikyu/aggregate.ts / shogai-seikyu/aggregate.ts) は、対象月が
--   (start_month <= 対象月 <= end_month)  (null は境界なし)
-- に入る行の formula_code を採用し、kaigo_service_codes を対象月の世代で引いて
-- formula (monthly_aggregate の numerator/denominator) を適用する。
-- 介護/障害 の区別は formula_code を各 system の service_codes で引けるかで自動判定
-- (介護コードは system='介護'、障害コードは system='障害' でしか解決しない)。
--
-- Supabase SQL Editor に貼って Run。冪等。未適用でも従来どおり applied_formula_codes に
-- フォールバックする (= このテーブルが無い間は動作不変)。
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS kaigo_office_addon_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id UUID NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  -- 処遇改善等の service_code (kaigo_service_codes.service_code)。例: 介護 116184 / 障害 115175
  formula_code TEXT NOT NULL,
  -- 適用期間 (YYYY-MM、両端含む)。null = 境界なし
  start_month TEXT,
  end_month TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 同一事業所×同一コード×同一開始月は1行
  UNIQUE (office_id, formula_code, start_month)
);

CREATE INDEX IF NOT EXISTS idx_kaigo_office_addon_periods_office
  ON kaigo_office_addon_periods (office_id);

DROP TRIGGER IF EXISTS trg_kaigo_office_addon_periods_updated_at ON kaigo_office_addon_periods;
CREATE TRIGGER trg_kaigo_office_addon_periods_updated_at
  BEFORE UPDATE ON kaigo_office_addon_periods
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE kaigo_office_addon_periods ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_all" ON kaigo_office_addon_periods;
CREATE POLICY "authenticated_all" ON kaigo_office_addon_periods
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;

-- 確認:
-- SELECT o.name, p.formula_code, p.start_month, p.end_month
--   FROM kaigo_office_addon_periods p JOIN offices o ON o.id = p.office_id
--  ORDER BY o.name, p.formula_code;
--
-- ロールバック:
-- DROP TABLE IF EXISTS kaigo_office_addon_periods;
