-- 障害福祉サービスの事業所番号を offices に登録する (2026-08-04)
--
-- offices.shogai_business_number が入っているのは 茂原 (1213100017) だけで、
-- 五井・大網・姉ム は未登録。このままアプリから障害伝送を出すと制御レコードの
-- 事業所番号が空になる (突合ハーネスは SHOGAI_BN env で代替していた)。
--
-- 番号の出所: ほのぼの実伝送 (KJ*/TJ*/JJ*) のコントロールレコード。
--   五井  1210600472  伝送データ/五井/障害/202606/ほのぼのから/KJ260701.CSV
--   大網  1210700306  伝送データ/大網/障害/202606/ほのぼのから/KJ260701.CSV
--   姉ム  1210600043  伝送データ/姉ム/障害/202606/ほのぼのから/KJ260802.CSV
--
-- 介護保険の事業所番号 (business_number) とは別番号なので上書きしないこと。

BEGIN;

-- 変更前スナップショット
CREATE TABLE IF NOT EXISTS _backup_offices_shogai_bn_20260804 AS
SELECT id, name, business_number, shogai_business_number
FROM offices
WHERE business_number IN ('1272401967', '1275800892', '1272400829');

UPDATE offices SET shogai_business_number = '1210600472'
WHERE business_number = '1272401967'   -- ＫＴ五井ヘルパーステーション
  AND shogai_business_number IS DISTINCT FROM '1210600472';

UPDATE offices SET shogai_business_number = '1210700306'
WHERE business_number = '1275800892'   -- リンクスヘルパーステーション大網白里
  AND shogai_business_number IS DISTINCT FROM '1210700306';

UPDATE offices SET shogai_business_number = '1210600043'
WHERE business_number = '1272400829'   -- ムツミヘルパーステーション (姉崎)
  AND shogai_business_number IS DISTINCT FROM '1210600043';

-- 確認
SELECT name, business_number AS 介護, shogai_business_number AS 障害
FROM offices
WHERE shogai_business_number IS NOT NULL
ORDER BY name;

COMMIT;
