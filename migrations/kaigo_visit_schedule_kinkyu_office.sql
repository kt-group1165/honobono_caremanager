-- ============================================================================
-- kaigo_visit_schedule: 緊急時訪問介護加算フラグ + 発生元 office_id
--                       + 2人体制の職員2/3 個別時間
-- ============================================================================
-- 2026-07-08 総点検 (シフト・提供票・帳票・実施記録 班 / C3+C5 契約)。
--
--   kinkyu_houmon : 緊急時訪問介護加算 (114000) の対象訪問フラグ。
--                   予定/実績の編集モーダル (shift-management / user-calendar) で
--                   チェック。集計側 (billing-visit) は
--                   「status='completed' AND kinkyu_houmon=true の行数」を数える。
--   office_id     : 予定の発生元事業所。シフト側の INSERT 全箇所で
--                   現在の office (?office= の currentOffice) を付与する。
--                   既存行は client_office_assignments 経由で利用者の
--                   訪問介護 office を backfill。
--   staff2/3_start_time, staff2/3_end_time :
--                   2人体制で職員2/3 の実担当時間が本体 (start_time/end_time) と
--                   異なる場合の個別時間 (交代・一部重なり)。NULL = 本体と同じ。
--                   給与計算・実施記録が各人の実時間を参照するために保存する。
--
-- UI 側は列未適用 (42703 / PGRST204) を許容して動作する (チェック非表示 /
-- office_id 付与スキップ) ため、適用前でも壊れない。
-- 適用: Supabase SQL Editor に本ブロックをそのまま貼って Run (COMMIT まで 1 ブロック)。

BEGIN;

ALTER TABLE kaigo_visit_schedule
  ADD COLUMN IF NOT EXISTS kinkyu_houmon BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE kaigo_visit_schedule
  ADD COLUMN IF NOT EXISTS office_id UUID REFERENCES offices(id);

-- 2人体制 (職員2/3) の個別時間 (NULL = 職員1と同じ時間)
ALTER TABLE kaigo_visit_schedule
  ADD COLUMN IF NOT EXISTS staff2_start_time TIME,
  ADD COLUMN IF NOT EXISTS staff2_end_time TIME,
  ADD COLUMN IF NOT EXISTS staff3_start_time TIME,
  ADD COLUMN IF NOT EXISTS staff3_end_time TIME;

-- 既存行の office_id backfill:
-- 利用者の「訪問介護」office (client_office_assignments 経由) を採用する。
UPDATE kaigo_visit_schedule s
SET office_id = (
  SELECT coa.office_id
  FROM client_office_assignments coa
  JOIN offices o ON o.id = coa.office_id
  WHERE coa.client_id = s.user_id
    AND o.service_type = '訪問介護'
  LIMIT 1
)
WHERE s.office_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_kaigo_visit_schedule_office_date
  ON kaigo_visit_schedule (office_id, visit_date);

COMMIT;
