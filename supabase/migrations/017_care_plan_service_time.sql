-- 017_care_plan_service_time.sql
-- kaigo_care_plan_services にサービス提供時間帯 (start_time/end_time) を追加
-- 提供票/利用票で時間帯ごとの行を管理できるようにする

ALTER TABLE kaigo_care_plan_services
  ADD COLUMN IF NOT EXISTS start_time TIME,
  ADD COLUMN IF NOT EXISTS end_time   TIME;

COMMENT ON COLUMN kaigo_care_plan_services.start_time IS 'サービス提供開始時刻 (HH:MM)';
COMMENT ON COLUMN kaigo_care_plan_services.end_time   IS 'サービス提供終了時刻 (HH:MM)';
