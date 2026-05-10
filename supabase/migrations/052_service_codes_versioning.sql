-- ===========================================================================
-- 052: kaigo_service_codes に valid_from ベースの履歴管理を追加
-- ===========================================================================
-- 目的:
--   介護報酬改定時に「同じ service_code でも適用期間ごとに異なる単位数」
--   を保持できるようにし、過去月の請求 (改定前単位での計算) と現在月の
--   請求 (新単位) を共存させる。
--
-- 変更内容:
--   1. UNIQUE (service_code) を DROP (1 コード = 1 行 → N 行可)
--   2. valid_from を NOT NULL (既存 NULL 行は '2024-06-01' = 令和6年6月改定基準)
--   3. UNIQUE (service_code, valid_from) を追加 (複合主キー化)
--
-- ロールバック:
--   ALTER TABLE kaigo_service_codes DROP CONSTRAINT kaigo_service_codes_service_code_valid_from_key;
--   ALTER TABLE kaigo_service_codes ADD CONSTRAINT kaigo_service_codes_service_code_key UNIQUE (service_code);
--   ALTER TABLE kaigo_service_codes ALTER COLUMN valid_from DROP NOT NULL;
-- ===========================================================================

BEGIN;

-- ── 1. 既存 valid_from NULL 行を埋める ────────────────────────────────────
-- 令和6年度報酬改定 = 2024-06-01 を default として埋める。
-- (より厳密には訪問介護一部 4月、その他 6月、令和7年4月施行分もあるが、
--  まずは安全な default として 6月 1日を使用。後から個別 UPDATE も可能。)
UPDATE kaigo_service_codes
SET valid_from = '2024-06-01'
WHERE valid_from IS NULL;

-- ── 2. valid_from を NOT NULL に ─────────────────────────────────────────
ALTER TABLE kaigo_service_codes
  ALTER COLUMN valid_from SET NOT NULL,
  ALTER COLUMN valid_from SET DEFAULT '2024-06-01';

-- ── 3. UNIQUE 制約の差し替え ─────────────────────────────────────────────
-- 旧 UNIQUE (service_code) を DROP
ALTER TABLE kaigo_service_codes
  DROP CONSTRAINT IF EXISTS kaigo_service_codes_service_code_key;

-- 新 UNIQUE (service_code, valid_from) を追加
ALTER TABLE kaigo_service_codes
  ADD CONSTRAINT kaigo_service_codes_service_code_valid_from_key
  UNIQUE (service_code, valid_from);

-- ── 4. 複合 lookup index ─────────────────────────────────────────────────
-- 「ある日付 D で有効な service_code の単位数」を引くクエリ用:
--   WHERE service_code = X AND valid_from <= D AND (valid_until IS NULL OR valid_until >= D)
CREATE INDEX IF NOT EXISTS idx_kaigo_service_codes_validity
  ON kaigo_service_codes(service_code, valid_from, valid_until);

COMMIT;

-- ===========================================================================
-- 確認クエリ (commit 後に実行):
-- ===========================================================================
-- 1) 制約の確認
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'kaigo_service_codes'::regclass
--     AND contype IN ('u', 'p');
--
-- 2) NULL valid_from が無いこと
--   SELECT COUNT(*) FROM kaigo_service_codes WHERE valid_from IS NULL;
--   -- 期待: 0
--
-- 3) ある日付で有効なコード一覧 (lookup pattern の確認)
--   SELECT * FROM kaigo_service_codes
--   WHERE service_code = '111111'
--     AND valid_from <= '2026-05-01'
--     AND (valid_until IS NULL OR valid_until >= '2026-05-01');
