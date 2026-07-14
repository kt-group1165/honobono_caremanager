-- ===========================================================================
-- service_code_import_batch.sql
-- サービスコードマスタ CSV 取込 (世代管理) の後戻り用スキーマ
-- ===========================================================================
-- 目的:
--   /master/service-codes の「CSV取込 (世代管理)」で投入した行を
--   取込単位 (import_batch_id) で識別し、「この取込を取り消す」で
--     1. INSERT した行の DELETE
--     2. クローズした旧世代の valid_until 復元 (closed_rows に復元情報を保持)
--   ができるようにする。
--
-- 方針: 完全に追加のみ (additive)・冪等。既存の請求・集計経路には影響しない
--   (import_batch_id は NULL 許容の新列、既存行は NULL のまま)。
--
-- Supabase SQL Editor に 1 ブロックで貼って Run (COMMIT まで含めること)。
-- ===========================================================================

BEGIN;

-- ── 1. kaigo_service_codes に取込バッチ ID 列を追加 (additive) ─────────────
ALTER TABLE kaigo_service_codes
  ADD COLUMN IF NOT EXISTS import_batch_id UUID;

COMMENT ON COLUMN kaigo_service_codes.import_batch_id IS
  'CSV取込 (世代管理) のバッチ ID。NULL = 手動登録 or 従来経路。kaigo_service_code_import_batches.id を参照 (FK は張らない: バッチ削除で行を守るため)';

CREATE INDEX IF NOT EXISTS idx_kaigo_service_codes_import_batch
  ON kaigo_service_codes(import_batch_id)
  WHERE import_batch_id IS NOT NULL;

-- ── 2. 取込バッチ履歴テーブル ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kaigo_service_code_import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name TEXT NOT NULL,
  -- 取込形式: sougou_standard = 総合事業 単位数表標準マスタ / generic = 汎用 (手動列マッピング)
  format TEXT NOT NULL CHECK (format IN ('sougou_standard', 'generic')),
  system TEXT NOT NULL CHECK (system IN ('介護', '障害', '総合事業', '独自')),
  valid_from DATE NOT NULL,
  -- 既存現行世代の扱い: revise = 旧世代クローズ + 世代追加 / skip = スキップ
  close_mode TEXT NOT NULL DEFAULT 'revise' CHECK (close_mode IN ('revise', 'skip')),
  inserted_count INTEGER NOT NULL DEFAULT 0,
  closed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  -- クローズした旧世代の復元情報: [{"id": "...", "service_code": "...", "prev_valid_until": "YYYY-MM-DD" | null}]
  closed_rows JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'reverted')),
  reverted_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE kaigo_service_code_import_batches IS
  'サービスコードマスタ CSV 取込 (世代管理) の履歴。closed_rows に旧世代の valid_until 復元情報を保持し、取込の取り消しを可能にする';

CREATE INDEX IF NOT EXISTS idx_kaigo_sc_import_batches_created
  ON kaigo_service_code_import_batches(created_at DESC);

-- ── 3. RLS (マスタは共通 = tenant 不要。authenticated 全許可) ──────────────
ALTER TABLE kaigo_service_code_import_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_all" ON kaigo_service_code_import_batches;
CREATE POLICY "authenticated_all" ON kaigo_service_code_import_batches
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;

-- ===========================================================================
-- 確認クエリ (commit 後に実行):
-- ===========================================================================
-- 1) 新列の存在
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'kaigo_service_codes' AND column_name = 'import_batch_id';
--
-- 2) バッチテーブルの存在 + 制約
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'kaigo_service_code_import_batches'::regclass;
--
-- 3) 既存行が import_batch_id NULL のままであること
--   SELECT COUNT(*) FROM kaigo_service_codes WHERE import_batch_id IS NOT NULL;
--   -- 期待: 0 (初回適用時)
--
-- ロールバック (完全 additive なので安全に戻せる):
--   DROP TABLE IF EXISTS kaigo_service_code_import_batches;
--   DROP INDEX IF EXISTS idx_kaigo_service_codes_import_batch;
--   ALTER TABLE kaigo_service_codes DROP COLUMN IF EXISTS import_batch_id;
