-- 認定情報 (client_insurance_records) に「限度額適用期間」を追加。
--
-- 背景 (2026-07-29): K vs KY 照合の残差 (おゆみ野2名・いすみ3名)。
-- 給付管理票 8222 項13/14 (限度額適用期間) は、区分変更等があると
-- 認定有効期間と異なる (ほのぼの「介護保険 全居宅.CSV」の
-- 「適用期間－開始日/終了日（居宅ｻｰﾋﾞｽ区分）」列が正)。
-- 従来は認定有効期間で代用しており、両者が一致しない利用者だけ KY と不一致だった。
-- NULL の場合は従来どおり認定有効期間で代用 (builder 側フォールバック)。
-- 取込: import_kyotaku_office.mjs (STEP1) / backfill: import_kyotaku_limit_period.mjs
BEGIN;

ALTER TABLE client_insurance_records
  ADD COLUMN IF NOT EXISTS limit_period_start date,
  ADD COLUMN IF NOT EXISTS limit_period_end date;

COMMENT ON COLUMN client_insurance_records.limit_period_start IS
  '限度額適用期間 開始 (8222項13)。NULLは認定有効期間で代用';
COMMENT ON COLUMN client_insurance_records.limit_period_end IS
  '限度額適用期間 終了 (8222項14)。NULLは認定有効期間で代用';

COMMIT;
