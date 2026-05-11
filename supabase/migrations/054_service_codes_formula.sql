-- ===========================================================================
-- 054: kaigo_service_codes に formula JSONB 列を追加 (動的単位計算対応)
-- ===========================================================================
-- 目的:
--   身体介護9 (4時間以上, 30分ごとに +82 単位) のような時間加算式や、
--   ・夜 (×1.25), ・深 (×1.5), ・2人 (×2), ・虐防 (×0.99) のような
--   modifier 式 を 1 行で表現できないコードに対し、計算方法を JSON で
--   保持してアプリ側で動的計算可能にする。
--
-- formula JSON 例:
--   1) time_increment (時間加算式):
--      { "type": "time_increment", "base_code": "111811", "base_units": 977,
--        "increment_unit": 82, "increment_minutes": 30, "min_minutes": 240 }
--      → minutes 分の利用で base + ceil((min - (min_minutes - inc_minutes)) / inc_minutes) × inc_unit
--
--   2) multiplier (% 加算/減算 / 2人介助):
--      { "type": "multiplier", "base_code": "111911", "factor": 1.25, "rounding": "round" }
--      → calculateUnits(base_code) × factor
--      rounding: "round" (四捨五入) / "floor" / "ceil" / "none"
--
--   3) chain (複合 — 複数 modifier を順次):
--      { "type": "chain", "steps": [
--          { "base_code": "111911", "factor": 1.25 },
--          { "factor": 0.99 }  // 前段の結果に適用
--        ]}
--
-- ロールバック:
--   ALTER TABLE kaigo_service_codes DROP COLUMN formula;
-- ===========================================================================

BEGIN;

ALTER TABLE kaigo_service_codes
  ADD COLUMN IF NOT EXISTS formula JSONB NULL;

COMMENT ON COLUMN kaigo_service_codes.formula IS
  '動的単位計算式 (NULL=固定単位 / type=time_increment|multiplier|chain)';

-- formula を持つコードの index (lookup 高速化)
CREATE INDEX IF NOT EXISTS idx_kaigo_service_codes_formula_present
  ON kaigo_service_codes((formula IS NOT NULL))
  WHERE formula IS NOT NULL;

COMMIT;

-- ===========================================================================
-- 確認クエリ:
--   SELECT service_code, service_name, units, formula
--   FROM kaigo_service_codes
--   WHERE formula IS NOT NULL
--   LIMIT 20;
-- ===========================================================================
