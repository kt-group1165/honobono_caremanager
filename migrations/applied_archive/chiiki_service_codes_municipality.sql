-- ============================================================================
-- 地域生活支援サービスコードに市町村軸を追加
--
-- 背景: 地域生活支援 (移動支援/訪問入浴/日中一時) はサービスコード体系・単価・様式が
-- 市町村ごとに全く別物。現状は千葉市の703件を system='地域生活支援' で投入しているが、
-- 市町村を区別する列が無い。2市目 (茂原市 等) を入れるとコードが混ざるため、千葉市
-- 単独の今のうちに municipality 軸を入れておく。
--
--   kaigo_service_codes.municipality = 地域生活支援コードの市町村 (例 '千葉市')。
--   介護保険・障害等の全国共通コードは NULL のまま。
--
-- ★ deadlock 対策: kaigo_service_codes は118k行。列追加(メタデータのみで即時)と、
--   700行だけの backfill、部分インデックスに分け、lock_timeout を掛ける。
--   Supabase SQL Editor に貼って Run。冪等。
-- ============================================================================

SET lock_timeout = '5s';

-- 列追加 (nullable・デフォルト無し → 行書換えなしの即時メタデータ変更)
BEGIN;
  ALTER TABLE kaigo_service_codes ADD COLUMN IF NOT EXISTS municipality TEXT;
COMMIT;

-- 既存の地域生活支援コード (千葉市の703件) を '千葉市' で backfill
BEGIN;
  UPDATE kaigo_service_codes
     SET municipality = '千葉市'
   WHERE system = '地域生活支援' AND municipality IS NULL;
COMMIT;

-- 検索用 部分インデックス (地域生活支援のみ = 700行程度。ロック小)
BEGIN;
  CREATE INDEX IF NOT EXISTS idx_service_codes_chiiki_muni
    ON kaigo_service_codes (municipality, service_category, valid_from)
    WHERE system = '地域生活支援';
COMMIT;

-- 確認:
-- SELECT municipality, count(*) FROM kaigo_service_codes
--  WHERE system='地域生活支援' GROUP BY municipality;
-- ロールバック:
-- DROP INDEX IF EXISTS idx_service_codes_chiiki_muni;
-- ALTER TABLE kaigo_service_codes DROP COLUMN IF EXISTS municipality;
