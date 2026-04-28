-- 051: 訪問介護のサービス種別ごとの利用状況
-- kaigo_user_office_services に home_care_categories(JSONB) を追加
-- 訪問介護事業所の場合に、サービス種別（介護/総合事業/居宅介護/重度訪問介護/
-- 同行援護/移動支援/自費）ごとに利用状態と期間を保持する

-- 形式: [
--   { "category": "介護",         "active": true,  "start_date": "2026-04-15", "end_date": null },
--   { "category": "総合事業",     "active": false, "start_date": null,         "end_date": null },
--   ...
-- ]

ALTER TABLE kaigo_user_office_services
  ADD COLUMN IF NOT EXISTS home_care_categories JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN kaigo_user_office_services.home_care_categories IS
  '訪問介護事業所のサービス種別ごとの利用状況（介護/総合事業/居宅介護/重度訪問介護/同行援護/移動支援/自費）';
