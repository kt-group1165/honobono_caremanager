-- ============================================================================
-- kaigo_visit_records: 予定 (kaigo_visit_schedule) 紐付け + 署名列
--
-- 目的:
--   1. schedule_id — サービス実施記録を予定と正式に紐付ける
--      (未紐付けの既存記録は UI 側で 訪問日+開始時刻 の一致によるベストエフォート表示)
--   2. 署名列 — 利用者確認サイン (signed_at / signer_name / signature_image_path)
--
-- 備考:
--   - 2026-07-08 時点の本番 DB では schedule_id (FK 込み) と署名列は既に存在する
--     ことを REST probe で確認済み → この SQL は冪等 (IF NOT EXISTS) で no-op。
--     未適用の環境 (staging 等) 向けのアーカイブとして残す。
--   - signature_data TEXT (dataURL 直保存) は追加しない。署名画像は既存の
--     電子署名 v2 方式に統一: Storage bucket "signatures" に PNG を置き、
--     signature_image_path に path を保存 → 表示時に signed URL を動的発行。
--     (signature_image_url は v1 互換の deprecated 列)
--   - Supabase SQL Editor では BEGIN;〜COMMIT; を 1 ブロックで貼って Run すること
--     (COMMIT 忘れは auto rollback される)。
-- ============================================================================

BEGIN;

-- 1. 予定との紐付け (予定削除時は記録を残して紐付けのみ解除)
ALTER TABLE kaigo_visit_records
  ADD COLUMN IF NOT EXISTS schedule_id UUID REFERENCES kaigo_visit_schedule(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_kaigo_visit_records_schedule_id
  ON kaigo_visit_records (schedule_id)
  WHERE schedule_id IS NOT NULL;

-- 2. 署名列 (電子署名 v2 適用済み環境では no-op)
ALTER TABLE kaigo_visit_records
  ADD COLUMN IF NOT EXISTS signature_image_path TEXT,
  ADD COLUMN IF NOT EXISTS signature_image_url TEXT,
  ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS signer_name TEXT;

COMMIT;
