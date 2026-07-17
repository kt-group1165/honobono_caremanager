-- 居宅サービス計画作成依頼(変更)届出年月日 を保持する列を追加。
--   国保連伝送 (居宅介護支援費明細書 8121 項15 / 給付管理票) に出す。
--   無いと認定開始日で代用され伝送ソフトの取込チェックで警告になる。
BEGIN;
ALTER TABLE kaigo_care_plans
  ADD COLUMN IF NOT EXISTS plan_request_date date;
COMMIT;
