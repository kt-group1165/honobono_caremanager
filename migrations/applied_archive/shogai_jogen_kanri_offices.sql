-- ============================================================================
-- 障害福祉: 自事業所が上限管理者の場合の関係事業所一覧 (2026-07-03)
-- ============================================================================
-- 上限管理編 3-1/3-2 対応。管理結果に関係事業所ごとの
-- (事業所番号/名称/総費用額/利用者負担額/調整後負担額) を JSONB で保持し、
-- 利用者負担上限額管理結果票の印刷に使う。

BEGIN;

ALTER TABLE shogai_jogen_kanri_results
  ADD COLUMN IF NOT EXISTS office_lines JSONB NOT NULL DEFAULT '[]';

COMMENT ON COLUMN shogai_jogen_kanri_results.office_lines IS
  '関係事業所一覧 [{office_number, office_name, total_amount, user_amount, adjusted_amount, is_self}]';

COMMIT;
