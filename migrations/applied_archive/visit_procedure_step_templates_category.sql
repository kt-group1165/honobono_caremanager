-- ============================================================
-- 訪問介護手順書 step テンプレート: category 列追加
-- 2026-06-24 user 確定 (= 事前定義 enum 11 カテゴリ)
-- ============================================================
--
-- カテゴリ:
--   挨拶・確認 / バイタル / 排泄 / 入浴 / 食事 / 服薬
--   / 移乗・歩行 / 掃除・洗濯 / 買物・通院 / 記録 / その他
--
-- 用途:
--   - 管理画面の filter / sort 軸
--   - 編集 page combobox の grouping
--
-- 既存行は「その他」を default に → 別途 register_seed_steps_as_templates.mjs
-- を再実行して keyword 自動分類で更新可能。
-- ============================================================

BEGIN;

ALTER TABLE kaigo_visit_procedure_step_templates
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'その他';

ALTER TABLE kaigo_visit_procedure_step_templates
  DROP CONSTRAINT IF EXISTS kaigo_visit_procedure_step_templates_category_check;

ALTER TABLE kaigo_visit_procedure_step_templates
  ADD CONSTRAINT kaigo_visit_procedure_step_templates_category_check
  CHECK (category IN (
    '挨拶・確認',
    'バイタル',
    '排泄',
    '入浴',
    '食事',
    '服薬',
    '移乗・歩行',
    '掃除・洗濯',
    '買物・通院',
    '記録',
    'その他'
  ));

-- フィルタ用 index (= office × category で絞り込み高速化)
CREATE INDEX IF NOT EXISTS idx_kaigo_visit_procedure_step_templates_office_category
  ON kaigo_visit_procedure_step_templates(office_id, category)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN kaigo_visit_procedure_step_templates.category IS
  'テンプレート カテゴリ (= 11 enum)。管理画面の filter / sort / grouping に使用。';

COMMIT;
