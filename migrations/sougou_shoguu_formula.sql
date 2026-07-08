-- 総合事業 (介護予防・日常生活支援総合事業) 訪問型サービス (service_category='A2') の
-- 処遇改善加算コードに formula (monthly_aggregate) を付与する。
--
-- 背景:
--   総合事業の処遇改善コード (CB_A26184「訪問介護相当サービス処遇改善加算Ⅱロ」units=266 等) は
--   units に「‰ (千分率)」の絶対値を持つが formula 列が null のため、集計側で率計算できない。
--   介護給付の処遇改善は kaigo_service_codes.formula = {"type":"monthly_aggregate","numerator":r,"denominator":1000}
--   を持ち、集計は「本体単位数 × numerator / denominator」で加算単位を出す。
--   総合事業も同じ仕組みに乗せるため、units をそのまま numerator に、denominator=1000 で formula を付与する。
--   (例: units=266 → 266/1000 = 26.6% 相当)
--
-- 対象:
--   system='総合事業' かつ service_category='A2' (訪問型) の処遇改善コードで
--   formula が未設定 (IS NULL) かつ units > 0 のもの。
--   CB_ (千葉市) / K_ (木更津・独自) 両保険者版を含む。
--   減算 (units<0) や units=0 は対象外。
--
-- 冪等性: formula IS NULL 条件により再実行しても既に付与済みの行は更新しない。
--
-- 実行: Supabase SQL Editor に BEGIN..COMMIT ごと貼り付けて Run (実行はユーザー)。
--   ※ 未適用のまま集計しても総合事業の処遇改善が 0 になるだけ (他は正しく集計される)。

BEGIN;

-- 適用前の対象件数を確認 (0 でなければ付与対象あり)
-- SELECT count(*) FROM kaigo_service_codes
--   WHERE system='総合事業' AND service_category='A2'
--     AND service_name LIKE '%処遇改善%' AND formula IS NULL AND units > 0;

UPDATE kaigo_service_codes
SET
  formula = jsonb_build_object(
    'type', 'monthly_aggregate',
    'numerator', units,
    'denominator', 1000
  ),
  updated_at = now()
WHERE system = '総合事業'
  AND service_category = 'A2'
  AND service_name LIKE '%処遇改善%'
  AND formula IS NULL
  AND units > 0;

-- 適用後の確認 (formula が入ったか)
-- SELECT service_code, units, formula FROM kaigo_service_codes
--   WHERE system='総合事業' AND service_category='A2' AND service_name LIKE '%処遇改善%'
--   ORDER BY service_code;

COMMIT;
