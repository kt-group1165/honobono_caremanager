-- 居宅の国保連伝送 (居宅介護支援費明細書 8124 / 給付管理票 8222) に必要な
--   介護支援専門員番号 (ケアマネ番号) を保持する列を kaigo_care_plans に追加。
--   利用者ごとに担当ケアマネの登録番号が入る (ほのぼの サービス計 CSV 由来)。
BEGIN;
ALTER TABLE kaigo_care_plans
  ADD COLUMN IF NOT EXISTS care_manager_number text;
COMMIT;
