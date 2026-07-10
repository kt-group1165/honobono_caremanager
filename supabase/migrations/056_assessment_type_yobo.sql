-- 056_assessment_type_yobo.sql
-- 介護予防のためのアセスメント (予防版) を kaigo_assessments テーブルに
-- assessment_type で共存させる。
--   'kaigo' = 従来の要介護版 (居宅サービス計画ガイドライン方式)
--   'yobo'  = 介護予防のためのアセスメント (要支援者等ケアマネジメント様式)
--
-- form_data (JSONB) に予防版の 4 領域 + 基本チェックリスト + 総合課題を格納する。
-- 既存行は全て 'kaigo' 扱い (DEFAULT 'kaigo' + NOT NULL)。
--
-- Supabase SQL Editor で貼る場合は BEGIN; ... COMMIT; の 1 ブロックで実行すること。

BEGIN;

-- 1. assessment_type 列の追加 (既存行は 'kaigo')
ALTER TABLE kaigo_assessments
  ADD COLUMN IF NOT EXISTS assessment_type TEXT NOT NULL DEFAULT 'kaigo';

-- 2. CHECK 制約 (既に存在する場合は貼り直し防止のため一旦 DROP)
ALTER TABLE kaigo_assessments
  DROP CONSTRAINT IF EXISTS kaigo_assessments_assessment_type_check;
ALTER TABLE kaigo_assessments
  ADD CONSTRAINT kaigo_assessments_assessment_type_check
  CHECK (assessment_type IN ('kaigo', 'yobo'));

-- 3. 一覧フィルタ用 index (user_id, assessment_type, certification_id)
CREATE INDEX IF NOT EXISTS idx_kaigo_assessments_type
  ON kaigo_assessments(user_id, assessment_type, certification_id);

COMMIT;
