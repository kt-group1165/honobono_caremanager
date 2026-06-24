-- ============================================================
-- 訪問介護手順書 step テンプレート: 同名で異なる detail を許可する
-- 2026-06-24 user 確定
-- ============================================================
--
-- 旧: UNIQUE (office_id, name)
-- 新: UNIQUE (office_id, name, COALESCE(detail, ''))
--      → 同じ name でも detail が違えば複数登録可
--      → NULL detail と空文字を同じ扱いにする (= NULL の複数許可を抑止)
-- ============================================================

BEGIN;

-- 旧 UNIQUE 制約を drop
ALTER TABLE kaigo_visit_procedure_step_templates
  DROP CONSTRAINT IF EXISTS kaigo_visit_procedure_step_templates_office_id_name_key;

-- 新 UNIQUE 制約 (= 式 index 経由で NULL を空文字扱い)
CREATE UNIQUE INDEX IF NOT EXISTS uq_kaigo_vpst_office_name_detail
  ON kaigo_visit_procedure_step_templates (office_id, name, COALESCE(detail, ''));

COMMENT ON INDEX uq_kaigo_vpst_office_name_detail IS
  '同 office 内で (name, detail) 重複禁止。NULL detail は空文字扱いで 1 つだけ許可。';

COMMIT;
