-- ★ 未適用。Supabase SQL Editor に貼って Run してください (BEGIN 〜 COMMIT の 1 ブロック)。
--
-- サービスコード CSV 取込 (世代管理) の履歴テーブルが、コードの想定と食い違っている。
--
-- applied_archive/service_code_import_batch.sql は 14 列で CREATE TABLE しているが、
-- `CREATE TABLE IF NOT EXISTS` なので **先に別バージョンの表が在ると列は追加されない**。
--
-- ── 実 DB の列 (PostgREST の OpenAPI から取得。2026-09-03) ────────────────
--   id uuid / format text / system text / valid_from date / close_mode text
--   ★ inserted_rows integer   ← コードの inserted_count と **同じ意味・違う名前**
--   closed_rows jsonb         ← ★ 型も名前もコードと一致 (配列を入れる)
--   status text / notes text / created_at timestamptz
--
--   本当に無い列 : file_name / closed_count / skipped_count / reverted_at
--
-- ⚠ **`ADD COLUMN inserted_count` は誤り。**`inserted_rows` と併存して
--   「同じ事実が 2 か所」になる。**追加ではなく RENAME する。**
--   (当初この SQL は 5 列 ADD で書いていた。列の**型と既存名**まで見ずに
--    「無い列」と判断したのが誤りだった。2026-09-03 に是正)
--
-- ⚠ `file_name` は **NULL 許容**にする。NOT NULL を DEFAULT なしで足すのは
--   「いま 0 行だから通る」だけで、他セッションが 1 行入れると失敗する。
--   コードは必ず値を入れるので NULL 許容で足りる。
--
-- ── RENAME の安全確認 (実施済) ────────────────────────────────────────────
--   `inserted_rows` の参照を 4 app + migrations + docs で grep → ★ 0 件。
--   同名で出るのは payroll_data_source_mode_v1.sql の **別テーブル**の列だけ。
--   closed_rows は コードが `{id, service_code, prev_valid_until}[]` を入れており
--   jsonb と整合している (service-code-import-dialog.tsx:58 / :421)。
--
-- ── 影響 (実測) ───────────────────────────────────────────────────────────
-- 画面 master/service-codes の CSV 取込は、最初にバッチ記録を insert してから
-- サービスコードを入れる作りになっている。その insert が存在しない列を渡すため
-- PostgREST が **行ごと拒否** (PGRST204) し、
--   service-code-import-dialog.tsx:417  toast.error(...) → **return**
-- で **取込そのものが必ず中断する**。つまり:
--
--   ★ 画面からサービスコードマスタの CSV 取込が 1 度もできない
--   ★ 「取込を取り消す」も update({ status, reverted_at }) で同じ理由で失敗する
--   ★ この表が 0 行なのは「未使用」ではなく **この不整合が原因**
--
-- ⚠ 画面の「SQL 未適用検知」は `id` と `kaigo_service_codes.import_batch_id` しか
--   見ていないため **緑のまま**になる (= 部分適用を検知できない)。
--   同じ commit で、実際に使う列を見るように直している。
--
-- ⚠ 実運用に影響していない理由: これまでのマスタ投入は SQL / migration script で
--   行っていて、この画面を使っていなかった。**金額は動いていない。**

BEGIN;

-- 0 行であることを確認してから進む (RENAME / 列追加の影響範囲を限定する)
DO $$
DECLARE n BIGINT;
BEGIN
  SELECT count(*) INTO n FROM kaigo_service_code_import_batches;
  IF n <> 0 THEN
    RAISE EXCEPTION '想定外: kaigo_service_code_import_batches に % 行あります。RENAME の影響を確認してください', n;
  END IF;
END $$;

-- ★ 追加ではなく改名 (同じ意味の列を 2 つ作らない)
ALTER TABLE kaigo_service_code_import_batches
  RENAME COLUMN inserted_rows TO inserted_count;

-- 本当に無い 4 列
ALTER TABLE kaigo_service_code_import_batches
  ADD COLUMN IF NOT EXISTS file_name     TEXT,
  ADD COLUMN IF NOT EXISTS closed_count  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skipped_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reverted_at   TIMESTAMPTZ;

COMMENT ON COLUMN kaigo_service_code_import_batches.file_name      IS '取り込んだ CSV のファイル名';
COMMENT ON COLUMN kaigo_service_code_import_batches.inserted_count IS '新世代として INSERT した件数 (旧名 inserted_rows)';
COMMENT ON COLUMN kaigo_service_code_import_batches.closed_count   IS 'valid_until を設定して閉じた旧世代の件数 (closed_rows は明細の jsonb で別物)';
COMMENT ON COLUMN kaigo_service_code_import_batches.skipped_count  IS '同一内容などでスキップした件数';
COMMENT ON COLUMN kaigo_service_code_import_batches.reverted_at    IS '取込を取り消した日時 (status=reverted のとき)';

COMMIT;

-- ── 適用後の確認 ──────────────────────────────────────────────────────────
-- 1) 列がそろったか
--    SELECT column_name, data_type, is_nullable, column_default
--      FROM information_schema.columns
--     WHERE table_name = 'kaigo_service_code_import_batches' ORDER BY column_name;
--    → inserted_rows が **消えて** inserted_count になっていること
--
-- 2) 検査が 0 件になるか
--    cd apps/kaigo-app && npx tsx scripts/insert-column-drift-check.mts
--
-- 3) ★ 「SQL を当てたら直ったはず」で終わらせない。
--    画面 (/master/service-codes → CSV 取込) で実際に 1 本取り込んで、
--    kaigo_service_code_import_batches が **0 行 → 1 行**になることを確認する。
--    ⚠ 取込は世代を増やすので、確認は **小さい CSV** か、確認後に画面の
--      「取込を取り消す」で戻すこと。
