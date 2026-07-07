-- ============================================================================
-- kaigo_visit_patterns.service_type の CHECK 制約解除 (2026-07-02)
-- ============================================================================
-- 旧パターン登録 UI の固定 5 択 (身体介護/生活援助/身体・生活/通院等乗降介助/
-- その他) を許可する CHECK が残っており、サービスコードマスタの正式名称
-- (身体介護3 等) を保存できない。パターンは ServiceSelector で正式名称を
-- 選択する方式に変更済のため、制約を解除する。

BEGIN;

ALTER TABLE kaigo_visit_patterns
  DROP CONSTRAINT kaigo_visit_patterns_service_type_check;

COMMIT;
