-- kaigo_care_plans.care_manager_name: ほのぼの CAREPLAN1.CSV の「作成者」氏名をそのまま保存する列。
--   care_manager_number (居宅サービス計CSV由来の公式な介護支援専門員番号) が
--   引けない/未取込の間も、後から名前ベースで正しい番号を追跡できるようにするため
--   (2026-09-02、40件・24拠点で care_manager_number が丸ごと未反映だった件の是正で追加)。
BEGIN;
ALTER TABLE kaigo_care_plans
  ADD COLUMN IF NOT EXISTS care_manager_name text;
COMMIT;
