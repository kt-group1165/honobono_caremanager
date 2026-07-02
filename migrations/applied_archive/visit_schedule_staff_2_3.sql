-- ============================================================================
-- kaigo_visit_schedule: 職員 2 / 職員 3 列追加
-- ============================================================================
-- 2 人同時対応 (2人介助) や同行 (新任研修等) で最大 3 名を割当てるため。
-- ほのぼの 月間個別画面の 職員1/2/3 列に対応。

BEGIN;

ALTER TABLE kaigo_visit_schedule
  ADD COLUMN IF NOT EXISTS staff_id_2 UUID REFERENCES members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS staff_id_3 UUID REFERENCES members(id) ON DELETE SET NULL;

COMMENT ON COLUMN kaigo_visit_schedule.staff_id_2 IS '職員2 (2人対応・同行)';
COMMENT ON COLUMN kaigo_visit_schedule.staff_id_3 IS '職員3 (2人対応・同行)';

COMMIT;
