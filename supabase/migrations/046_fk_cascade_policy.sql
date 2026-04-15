-- 046: 外部キー制約のCASCADE/SET NULLポリシー統一
-- 孤立データが発生しないよう、全FKに適切な ON DELETE を設定

-- ============================================================
-- グループA: 親削除時に子も削除（CASCADE）
-- ============================================================

-- emergency_status.token_id: トークン削除でステータスも消す
ALTER TABLE kaigo_emergency_status
  DROP CONSTRAINT IF EXISTS kaigo_emergency_status_token_id_fkey,
  ADD CONSTRAINT kaigo_emergency_status_token_id_fkey
    FOREIGN KEY (token_id) REFERENCES kaigo_emergency_tokens(id) ON DELETE CASCADE;

-- monitoring_sheets.care_plan_id: ケアプラン削除でモニタリングも消す
ALTER TABLE kaigo_monitoring_sheets
  DROP CONSTRAINT IF EXISTS kaigo_monitoring_sheets_care_plan_id_fkey,
  ADD CONSTRAINT kaigo_monitoring_sheets_care_plan_id_fkey
    FOREIGN KEY (care_plan_id) REFERENCES kaigo_care_plans(id) ON DELETE CASCADE;

-- report_documents.care_plan_id: ケアプラン削除で帳票も消す
ALTER TABLE kaigo_report_documents
  DROP CONSTRAINT IF EXISTS kaigo_report_documents_care_plan_id_fkey,
  ADD CONSTRAINT kaigo_report_documents_care_plan_id_fkey
    FOREIGN KEY (care_plan_id) REFERENCES kaigo_care_plans(id) ON DELETE CASCADE;

-- ============================================================
-- グループB: 親削除時は参照クリア、子は残す（SET NULL）
-- ============================================================

-- ai_usage_logs.user_id: ユーザ削除後も監査ログは残す
ALTER TABLE kaigo_ai_usage_logs
  DROP CONSTRAINT IF EXISTS kaigo_ai_usage_logs_user_id_fkey,
  ADD CONSTRAINT kaigo_ai_usage_logs_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES kaigo_users(id) ON DELETE SET NULL;

-- care_plans.created_by: 作成者退職後もケアプランは残す
ALTER TABLE kaigo_care_plans
  DROP CONSTRAINT IF EXISTS kaigo_care_plans_created_by_fkey,
  ADD CONSTRAINT kaigo_care_plans_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES kaigo_staff(id) ON DELETE SET NULL;

-- service_records.staff_id: 記録は残す
ALTER TABLE kaigo_service_records
  DROP CONSTRAINT IF EXISTS kaigo_service_records_staff_id_fkey,
  ADD CONSTRAINT kaigo_service_records_staff_id_fkey
    FOREIGN KEY (staff_id) REFERENCES kaigo_staff(id) ON DELETE SET NULL;

-- users.care_manager_staff_id: 担当ケアマネ退職時も利用者は残す
ALTER TABLE kaigo_users
  DROP CONSTRAINT IF EXISTS kaigo_users_care_manager_staff_id_fkey,
  ADD CONSTRAINT kaigo_users_care_manager_staff_id_fkey
    FOREIGN KEY (care_manager_staff_id) REFERENCES kaigo_staff(id) ON DELETE SET NULL;

-- visit_patterns.staff_id: パターンは残す
ALTER TABLE kaigo_visit_patterns
  DROP CONSTRAINT IF EXISTS kaigo_visit_patterns_staff_id_fkey,
  ADD CONSTRAINT kaigo_visit_patterns_staff_id_fkey
    FOREIGN KEY (staff_id) REFERENCES kaigo_staff(id) ON DELETE SET NULL;

-- visit_records.schedule_id: 予定削除でも実績は残す
ALTER TABLE kaigo_visit_records
  DROP CONSTRAINT IF EXISTS kaigo_visit_records_schedule_id_fkey,
  ADD CONSTRAINT kaigo_visit_records_schedule_id_fkey
    FOREIGN KEY (schedule_id) REFERENCES kaigo_visit_schedule(id) ON DELETE SET NULL;

-- visit_records.staff_id: 実績は残す
ALTER TABLE kaigo_visit_records
  DROP CONSTRAINT IF EXISTS kaigo_visit_records_staff_id_fkey,
  ADD CONSTRAINT kaigo_visit_records_staff_id_fkey
    FOREIGN KEY (staff_id) REFERENCES kaigo_staff(id) ON DELETE SET NULL;

-- visit_schedule.pattern_id: 予定は残す
ALTER TABLE kaigo_visit_schedule
  DROP CONSTRAINT IF EXISTS kaigo_visit_schedule_pattern_id_fkey,
  ADD CONSTRAINT kaigo_visit_schedule_pattern_id_fkey
    FOREIGN KEY (pattern_id) REFERENCES kaigo_visit_patterns(id) ON DELETE SET NULL;

-- visit_schedule.staff_id: 予定は残す（再割当可能）
ALTER TABLE kaigo_visit_schedule
  DROP CONSTRAINT IF EXISTS kaigo_visit_schedule_staff_id_fkey,
  ADD CONSTRAINT kaigo_visit_schedule_staff_id_fkey
    FOREIGN KEY (staff_id) REFERENCES kaigo_staff(id) ON DELETE SET NULL;
