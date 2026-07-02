-- ============================================================================
-- 独自サービス分類の追加 + 「同行」コード登録 (2026-07-02)
-- ============================================================================
-- 法定 3 制度 (介護/障害/総合事業) とは別に、事業所が独自に定義する
-- サービス分類 system='独自' を追加する。第 1 号として「同行」
-- (研修・引継ぎ等での同行訪問の予定管理用、単位数なし) を登録。
--
-- 注意: 独自サービスは保険請求の対象外。請求集計は system='介護' 等で
--       フィルタしているため、'独自' の行は集計に混ざらない。

BEGIN;

ALTER TABLE kaigo_service_codes DROP CONSTRAINT kaigo_service_codes_system_check;
ALTER TABLE kaigo_service_codes ADD CONSTRAINT kaigo_service_codes_system_check
  CHECK (system IN ('介護', '障害', '総合事業', '独自'));

INSERT INTO kaigo_service_codes
  (system, service_category, service_category_name, service_code, service_name,
   short_name, units, unit_type, calculation_type, valid_from, notes)
VALUES
  ('独自', '90', '独自サービス', '900001', '同行',
   '同行', 0, '1回につき', '基本', '2026-04-01',
   '独自サービス (法定外・単位数なし)。研修/引継ぎ等の同行訪問の予定管理用')
ON CONFLICT (system, service_code, valid_from) DO NOTHING;

COMMIT;
