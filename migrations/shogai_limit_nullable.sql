-- ============================================================================
-- 障害福祉: 負担上限月額 (shougai_certifications.self_payment_limit) の意味分離
--   null = 未設定 / 0 = 負担0円 (低所得区分・生保等)
--
-- 背景:
--   従来は NOT NULL DEFAULT 0 で「0 = 未設定扱い」だったため、集計側が
--   `limit > 0` のときだけ上限適用 → 本当に「上限 0 円」の利用者に
--   1 割満額を請求してしまう矛盾があった (J121 項16 上限月額調整=0 と
--   項21 決定利用者負担額=1割 が不一致になる)。
--   → 0 を有効な上限値として扱い、「未設定」は NULL で表す。
--
-- 既存データ確認 (2026-07-08 REST で確認済):
--   self_payment_limit = 0 の行は 1 件のみで seiho_flag = true (生保)。
--   生保は「負担 0 円」が正しい意味なので 0 のまま残す (UPDATE 不要)。
--
-- 適用: Supabase SQL Editor に貼って Run (BEGIN..COMMIT 一括)
-- ============================================================================

BEGIN;

ALTER TABLE shougai_certifications
  ALTER COLUMN self_payment_limit DROP DEFAULT,
  ALTER COLUMN self_payment_limit DROP NOT NULL;

COMMENT ON COLUMN shougai_certifications.self_payment_limit IS
  '利用者負担上限月額 (円)。NULL = 未設定 / 0 = 負担0円 (低所得区分・生保等)';

COMMIT;
