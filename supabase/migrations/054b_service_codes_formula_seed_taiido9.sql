-- ===========================================================================
-- 054b: 身体介護9 系 formula seed (令和6年度報酬改定)
-- ===========================================================================
-- 前提: 054_service_codes_formula.sql で formula JSONB 列が追加済。
--       service_codes_zaitaku.csv で身体介護9 系コードが units=0 で投入済。
--
-- 構造:
--   身体介護9 base = 身体介護8 (977 単位) + 30分ごとに +82 単位 (4時間以上)
--   ・夜 = base × 1.25 / ・深 = base × 1.5 / ・2人 = base × 2
--   ・虐防 = base × 0.99 / ・業未 = base × 0.99
--
-- formula JSON 構造詳細は 054 migration コメント参照。
-- ===========================================================================

BEGIN;

-- ── 身体介護9 base (time_increment) ──────────────────────────────────────
UPDATE kaigo_service_codes
  SET formula = jsonb_build_object(
    'type', 'time_increment',
    'base_code', '111811',     -- 身体介護8 (4時間以下の最上位 tier)
    'base_units', 977,
    'increment_unit', 82,
    'increment_minutes', 30,
    'min_minutes', 240
  )
  WHERE system = '介護' AND service_code = '111911';

-- ── 身体介護9・夜 (× 1.25 加算) ──────────────────────────────────────────
UPDATE kaigo_service_codes
  SET formula = jsonb_build_object(
    'type', 'multiplier',
    'base_code', '111911',
    'factor', 1.25,
    'rounding', 'round'
  )
  WHERE system = '介護' AND service_code = '111912';

-- ── 身体介護9・深 (× 1.5 加算) ───────────────────────────────────────────
UPDATE kaigo_service_codes
  SET formula = jsonb_build_object(
    'type', 'multiplier',
    'base_code', '111911',
    'factor', 1.5,
    'rounding', 'round'
  )
  WHERE system = '介護' AND service_code = '111913';

-- ── 身体介護9・2人 (× 2.0) ──────────────────────────────────────────────
UPDATE kaigo_service_codes
  SET formula = jsonb_build_object(
    'type', 'multiplier',
    'base_code', '111911',
    'factor', 2.0
  )
  WHERE system = '介護' AND service_code = '111921';

-- ── 身体介護9・2人・夜 = base × 2 × 1.25 ─────────────────────────────────
UPDATE kaigo_service_codes
  SET formula = jsonb_build_object(
    'type', 'multiplier',
    'base_code', '111921',
    'factor', 1.25,
    'rounding', 'round'
  )
  WHERE system = '介護' AND service_code = '111922';

-- ── 身体介護9・2人・深 = base × 2 × 1.5 ──────────────────────────────────
UPDATE kaigo_service_codes
  SET formula = jsonb_build_object(
    'type', 'multiplier',
    'base_code', '111921',
    'factor', 1.5,
    'rounding', 'round'
  )
  WHERE system = '介護' AND service_code = '111923';

-- ── 業未 (業務継続計画未策定減算 1%) 系 ──────────────────────────────────
-- 身体介護9・業未 = base × 0.99
UPDATE kaigo_service_codes
  SET formula = jsonb_build_object(
    'type', 'multiplier',
    'base_code', '111911',
    'factor', 0.99,
    'rounding', 'round'
  )
  WHERE system = '介護' AND service_code = '11B809';

-- 身体介護9・業未・夜
UPDATE kaigo_service_codes
  SET formula = jsonb_build_object(
    'type', 'multiplier',
    'base_code', '11B809',
    'factor', 1.25,
    'rounding', 'round'
  )
  WHERE system = '介護' AND service_code = '11B810';

-- 身体介護9・業未・深
UPDATE kaigo_service_codes
  SET formula = jsonb_build_object(
    'type', 'multiplier',
    'base_code', '11B809',
    'factor', 1.5,
    'rounding', 'round'
  )
  WHERE system = '介護' AND service_code = '11B811';

-- 身体介護9・業未・2人
UPDATE kaigo_service_codes
  SET formula = jsonb_build_object(
    'type', 'multiplier',
    'base_code', '11B809',
    'factor', 2.0
  )
  WHERE system = '介護' AND service_code = '11B812';

-- 身体介護9・業未・2人・夜
UPDATE kaigo_service_codes
  SET formula = jsonb_build_object(
    'type', 'multiplier',
    'base_code', '11B812',
    'factor', 1.25,
    'rounding', 'round'
  )
  WHERE system = '介護' AND service_code = '11B813';

-- 身体介護9・業未・2人・深
UPDATE kaigo_service_codes
  SET formula = jsonb_build_object(
    'type', 'multiplier',
    'base_code', '11B812',
    'factor', 1.5,
    'rounding', 'round'
  )
  WHERE system = '介護' AND service_code = '11B814';

-- ── 虐防 (高齢者虐待防止措置未実施減算 1%) 系 ────────────────────────────
-- 身体介護9・虐防 = base × 0.99
UPDATE kaigo_service_codes
  SET formula = jsonb_build_object(
    'type', 'multiplier',
    'base_code', '111911',
    'factor', 0.99,
    'rounding', 'round'
  )
  WHERE system = '介護' AND service_code = '11A205';

-- 身体介護9・虐防・夜
UPDATE kaigo_service_codes
  SET formula = jsonb_build_object(
    'type', 'multiplier',
    'base_code', '11A205',
    'factor', 1.25,
    'rounding', 'round'
  )
  WHERE system = '介護' AND service_code = '11A206';

-- 身体介護9・虐防・深
UPDATE kaigo_service_codes
  SET formula = jsonb_build_object(
    'type', 'multiplier',
    'base_code', '11A205',
    'factor', 1.5,
    'rounding', 'round'
  )
  WHERE system = '介護' AND service_code = '11A207';

-- 身体介護9・虐防・2人
UPDATE kaigo_service_codes
  SET formula = jsonb_build_object(
    'type', 'multiplier',
    'base_code', '11A205',
    'factor', 2.0
  )
  WHERE system = '介護' AND service_code = '11A208';

-- 身体介護9・虐防・2人・夜
UPDATE kaigo_service_codes
  SET formula = jsonb_build_object(
    'type', 'multiplier',
    'base_code', '11A208',
    'factor', 1.25,
    'rounding', 'round'
  )
  WHERE system = '介護' AND service_code = '11A209';

-- 身体介護9・虐防・2人・深
UPDATE kaigo_service_codes
  SET formula = jsonb_build_object(
    'type', 'multiplier',
    'base_code', '11A208',
    'factor', 1.5,
    'rounding', 'round'
  )
  WHERE system = '介護' AND service_code = '11A210';

-- ── 虐防・業未 (両方適用 0.99 × 0.99 ≒ 0.9801) ─────────────────────────
-- 身体介護9・虐防・業未
UPDATE kaigo_service_codes
  SET formula = jsonb_build_object(
    'type', 'multiplier',
    'base_code', '11A205',
    'factor', 0.99,
    'rounding', 'round'
  )
  WHERE system = '介護' AND service_code = '11B815';

UPDATE kaigo_service_codes SET formula = jsonb_build_object('type','multiplier','base_code','11B815','factor',1.25,'rounding','round') WHERE system = '介護' AND service_code = '11B816';
UPDATE kaigo_service_codes SET formula = jsonb_build_object('type','multiplier','base_code','11B815','factor',1.5,'rounding','round')  WHERE system = '介護' AND service_code = '11B817';
UPDATE kaigo_service_codes SET formula = jsonb_build_object('type','multiplier','base_code','11B815','factor',2.0) WHERE system = '介護' AND service_code = '11B818';
UPDATE kaigo_service_codes SET formula = jsonb_build_object('type','multiplier','base_code','11B818','factor',1.25,'rounding','round') WHERE system = '介護' AND service_code = '11B819';
UPDATE kaigo_service_codes SET formula = jsonb_build_object('type','multiplier','base_code','11B818','factor',1.5,'rounding','round')  WHERE system = '介護' AND service_code = '11B820';

COMMIT;

-- ===========================================================================
-- 確認:
--   SELECT service_code, service_name, units, formula FROM kaigo_service_codes
--   WHERE service_code LIKE '111911' OR service_code LIKE '11A20%' OR service_code LIKE '11B8%';
-- ===========================================================================
