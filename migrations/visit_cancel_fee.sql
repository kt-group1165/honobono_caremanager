-- ============================================================================
-- 訪問キャンセル (欠課) とキャンセル料の管理 (2026-07-11)
-- ============================================================================
-- 背景:
--   利用者都合のキャンセルは保険請求不可 (実績にしない) だが、事業所規定により
--   キャンセル料 (自費) を利用者に請求できる (重要事項説明書で定める)。
--   従来は削除するしかなく記録が残らなかった。
--
-- 設計:
--   - kaigo_visit_schedule.status の CHECK は 012_shift_management.sql 由来で
--     既に ('scheduled','completed','cancelled','changed') を許可している
--     (2026-07-11 に pg 定義 grep + REST プローブで確認。cancelled 行は 0 件)。
--     → status='cancelled' をそのまま使い、付帯情報の列だけ追加する。
--   - キャンセル料は riyou_jippi_entries (利用実費) に schedule_id 付きで連動し、
--     利用請求タブの請求書に合算する。schedule_id UNIQUE で二重計上を防止。
--
-- 冪等: 何度流しても安全 (IF NOT EXISTS / DO ブロック内条件判定)。
-- Supabase SQL Editor に BEGIN〜COMMIT ごと貼って Run すること。

BEGIN;

-- ── 1) kaigo_visit_schedule にキャンセル系列を追加 ──────────────────────────
ALTER TABLE kaigo_visit_schedule ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE kaigo_visit_schedule ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE kaigo_visit_schedule ADD COLUMN IF NOT EXISTS cancel_fee INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN kaigo_visit_schedule.cancelled_at IS 'キャンセル操作日時 (status=cancelled のとき設定)';
COMMENT ON COLUMN kaigo_visit_schedule.cancel_reason IS 'キャンセル理由 (利用者都合・当日連絡 等)';
COMMENT ON COLUMN kaigo_visit_schedule.cancel_fee IS 'キャンセル料 (円)。0 = 記録のみ。>0 は riyou_jippi_entries に連動';

-- ── 2) status CHECK に cancelled が含まれることを保証 (保険) ─────────────────
--    万一 CHECK が 'cancelled' を含まない形に変わっていた場合のみ
--    DROP → ADD で再作成する (CLAUDE.md 4.1 の流儀。UPDATE 対象データは無い)。
DO $$
DECLARE
  con RECORD;
BEGIN
  FOR con IN
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'kaigo_visit_schedule'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
      AND pg_get_constraintdef(oid) ILIKE '%scheduled%'
  LOOP
    IF con.def NOT ILIKE '%cancelled%' THEN
      EXECUTE format('ALTER TABLE kaigo_visit_schedule DROP CONSTRAINT %I', con.conname);
      EXECUTE format(
        'ALTER TABLE kaigo_visit_schedule ADD CONSTRAINT %I CHECK (status IN (''scheduled'', ''completed'', ''cancelled'', ''changed''))',
        con.conname
      );
      RAISE NOTICE 'status CHECK % を cancelled 込みで再作成しました', con.conname;
    END IF;
  END LOOP;
END $$;

-- ── 3) 利用実費 (riyou_jippi_entries) との連動列 ─────────────────────────────
--    schedule_id: キャンセル料の発生元予定。UNIQUE index で同一予定からの
--    二重計上を防止 (NULL は手入力実費なので複数可 = NULLs distinct)。
--    ON DELETE SET NULL: 予定が物理削除されても実費行 (請求記録) は残す。
DO $$
BEGIN
  IF to_regclass('riyou_jippi_entries') IS NOT NULL THEN
    ALTER TABLE riyou_jippi_entries
      ADD COLUMN IF NOT EXISTS schedule_id UUID REFERENCES kaigo_visit_schedule(id) ON DELETE SET NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_riyou_jippi_schedule_id
      ON riyou_jippi_entries (schedule_id);
  ELSE
    RAISE NOTICE 'riyou_jippi_entries が未作成です。先に riyou_jippi.sql を適用してください';
  END IF;
END $$;

-- ── 4) キャンセル行の月次集計用 index (部分 index、行数は少ない想定) ────────
CREATE INDEX IF NOT EXISTS idx_kaigo_visit_schedule_cancelled
  ON kaigo_visit_schedule (visit_date)
  WHERE status = 'cancelled';

COMMIT;

-- ── 適用後の確認 ─────────────────────────────────────────────────────────────
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'kaigo_visit_schedule' AND column_name LIKE 'cancel%';
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'kaigo_visit_schedule'::regclass AND contype = 'c';
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'riyou_jippi_entries' AND column_name = 'schedule_id';
