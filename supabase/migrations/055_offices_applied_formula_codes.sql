-- ===========================================================================
-- 055: offices に applied_formula_codes (= 自事業所が取得している加算) 列追加
-- ===========================================================================
-- 目的:
--   処遇改善加算 等の集計型 formula を「事業所単位」で適用する。
--   これまで localStorage で per-browser に持っていたのを、DB に格納して
--   全 staff 共通の事業所設定にする。
--
-- 列:
--   applied_formula_codes TEXT[] DEFAULT '{}' — 適用する service_code の配列
--     例: ['116275', '116XX1', ...] — 訪問介護処遇改善加算Ⅰ + サ提強Ⅰ 等
--
-- ロールバック:
--   ALTER TABLE offices DROP COLUMN applied_formula_codes;
-- ===========================================================================

BEGIN;

ALTER TABLE offices
  ADD COLUMN IF NOT EXISTS applied_formula_codes TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN offices.applied_formula_codes IS
  '自事業所が取得している加算 (処遇改善加算等の formula 系) service_code 配列';

COMMIT;

-- ===========================================================================
-- 確認:
--   SELECT id, name, applied_formula_codes FROM offices LIMIT 5;
-- ===========================================================================
