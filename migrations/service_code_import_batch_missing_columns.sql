-- ★ 未適用。Supabase SQL Editor に貼って Run してください (BEGIN 〜 COMMIT の 1 ブロック)。
--
-- サービスコード CSV 取込 (世代管理) の履歴テーブルに **5 列が足りていない**。
--
-- applied_archive/service_code_import_batch.sql は 14 列で CREATE TABLE しているが、
-- `CREATE TABLE IF NOT EXISTS` なので **先に別バージョンの表が在ると列は追加されない**。
-- 実 DB を 1 列ずつ確認した結果 (2026-09-03):
--
--   実在  9 : id / format / system / valid_from / close_mode / closed_rows /
--             status / notes / created_at
--   ★欠落 5 : file_name / inserted_count / closed_count / skipped_count / reverted_at
--
-- ── 影響 (実測) ───────────────────────────────────────────────────────────
-- 画面 master/service-codes の CSV 取込は、最初にバッチ記録を insert してから
-- サービスコードを入れる作りになっている。その insert が欠落列を渡すため
-- PostgREST が **行ごと拒否** (PGRST204) し、
--   service-code-import-dialog.tsx:417  toast.error(...) → **return**
-- で **取込そのものが必ず中断する**。つまり:
--
--   ★ 画面からサービスコードマスタの CSV 取込が 1 度もできない
--   ★ 「取込を取り消す」も update({ status, reverted_at }) で同じ理由で失敗する
--   ★ kaigo_service_code_import_batches が 0 行なのは「未使用」ではなく **この不整合が原因**
--
-- ⚠ 画面の「SQL 未適用検知」は `id` と `kaigo_service_codes.import_batch_id` しか
--   見ていないため **緑のまま**になる (= 部分適用を検知できない)。
--   同じ commit で、実際に使う列を見るように直している。
--
-- ⚠ 実運用に影響していない理由: これまでのマスタ投入は SQL / migration script で
--   行っていて、この画面を使っていなかった。**金額は動いていない。**
--
-- ⚠ 現在 0 行なので NOT NULL を後付けしても既存行に違反は出ない (実測で確認済)。
--   もし 0 行でない環境があれば、先に DEFAULT を入れてから NOT NULL にすること。

BEGIN;

-- 念のため: 0 行でないなら止める (NOT NULL 後付けが失敗するのを防ぐ)
DO $$
DECLARE n BIGINT;
BEGIN
  SELECT count(*) INTO n FROM kaigo_service_code_import_batches;
  IF n <> 0 THEN
    RAISE EXCEPTION '想定外: kaigo_service_code_import_batches に % 行あります。NOT NULL の後付け方法を見直してください', n;
  END IF;
END $$;

ALTER TABLE kaigo_service_code_import_batches
  ADD COLUMN IF NOT EXISTS file_name      TEXT    NOT NULL,
  ADD COLUMN IF NOT EXISTS inserted_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS closed_count   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skipped_count  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reverted_at    TIMESTAMPTZ;

COMMENT ON COLUMN kaigo_service_code_import_batches.file_name      IS '取り込んだ CSV のファイル名';
COMMENT ON COLUMN kaigo_service_code_import_batches.inserted_count IS '新世代として INSERT した件数';
COMMENT ON COLUMN kaigo_service_code_import_batches.closed_count   IS 'valid_until を設定して閉じた旧世代の件数';
COMMENT ON COLUMN kaigo_service_code_import_batches.skipped_count  IS '同一内容などでスキップした件数';
COMMENT ON COLUMN kaigo_service_code_import_batches.reverted_at    IS '取込を取り消した日時 (status=reverted のとき)';

COMMIT;

-- 適用後の確認 (14 列そろっていること):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'kaigo_service_code_import_batches' ORDER BY column_name;
-- 画面側は npx tsx scripts/insert-column-drift-check.mts で 0 件になることを確認する。
