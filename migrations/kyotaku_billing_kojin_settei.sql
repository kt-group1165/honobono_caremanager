-- 請求個人設定タブ (居宅介護支援) 用: 運営基準減算 (所定単位数の 50% 減算) 列を追加
-- 2026-07-08 総点検 Task 8a
-- Supabase SQL Editor に 1 ブロックで貼って Run (COMMIT まで含める)

BEGIN;

ALTER TABLE kaigo_care_support_claims
  ADD COLUMN IF NOT EXISTS unei_kijun_gensan BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS unei_kijun_gensan_units INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN kaigo_care_support_claims.unei_kijun_gensan IS
  '運営基準減算 (所定単位数×50%減。減算量 = 所定 − round(所定×0.5))';
COMMENT ON COLUMN kaigo_care_support_claims.unei_kijun_gensan_units IS
  '運営基準減算の減算単位数 (正の値で保持)';

COMMIT;
