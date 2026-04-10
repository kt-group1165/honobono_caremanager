-- 029_backfill_kaigo_care_plans.sql
-- 帳票画面で計画書を作成すると kaigo_report_documents に保存されるが、
-- 別テーブル kaigo_care_plans には自動作成されないケースがあった。
-- 支援経過・モニタリング等は kaigo_care_plans を参照しているため、
-- 「有効なケアプランがありません」と表示される問題が発生する。
--
-- このマイグレーションは、care-plan-1 ドキュメントを持つが kaigo_care_plans
-- レコードを持たない利用者に対して、自動でレコードを作成する。

-- ───────────────────────────────────────────────────────────────────────────
-- Step 1: care-plan-1 ドキュメントを持つが kaigo_care_plans が無い利用者に
--         認定情報の期間でケアプランを自動作成
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO kaigo_care_plans (
  user_id,
  plan_number,
  plan_type,
  start_date,
  end_date,
  long_term_goals,
  short_term_goals,
  status
)
SELECT DISTINCT
  d.user_id,
  '',
  '居宅サービス計画',
  COALESCE(
    (SELECT c.start_date FROM kaigo_care_certifications c
     WHERE c.user_id = d.user_id ORDER BY c.start_date DESC LIMIT 1),
    CURRENT_DATE
  ),
  COALESCE(
    (SELECT c.end_date FROM kaigo_care_certifications c
     WHERE c.user_id = d.user_id ORDER BY c.start_date DESC LIMIT 1),
    CURRENT_DATE + INTERVAL '365 days'
  ),
  '',
  '',
  'active'
FROM kaigo_report_documents d
WHERE d.report_type = 'care-plan-1'
  AND NOT EXISTS (
    SELECT 1 FROM kaigo_care_plans p WHERE p.user_id = d.user_id
  );

-- ───────────────────────────────────────────────────────────────────────────
-- Step 2: care-plan-1/2/3 ドキュメントの care_plan_id が NULL の場合、
--         作成された(or 既存の)kaigo_care_plans を紐づける
-- ───────────────────────────────────────────────────────────────────────────
UPDATE kaigo_report_documents d
SET care_plan_id = (
  SELECT p.id FROM kaigo_care_plans p
  WHERE p.user_id = d.user_id
  ORDER BY p.start_date DESC
  LIMIT 1
)
WHERE d.report_type IN ('care-plan-1', 'care-plan-2', 'care-plan-3')
  AND d.care_plan_id IS NULL
  AND EXISTS (
    SELECT 1 FROM kaigo_care_plans p WHERE p.user_id = d.user_id
  );

-- ───────────────────────────────────────────────────────────────────────────
-- Step 3: kaigo_support_records も同様に紐づけ直し
-- ───────────────────────────────────────────────────────────────────────────
UPDATE kaigo_support_records sr
SET care_plan_id = (
  SELECT p.id FROM kaigo_care_plans p
  WHERE p.user_id = sr.user_id
  ORDER BY p.start_date DESC
  LIMIT 1
)
WHERE sr.care_plan_id IS NULL
  AND EXISTS (
    SELECT 1 FROM kaigo_care_plans p WHERE p.user_id = sr.user_id
  );

-- ───────────────────────────────────────────────────────────────────────────
-- 確認用 SELECT (コメントアウト)
-- ───────────────────────────────────────────────────────────────────────────
-- SELECT u.name,
--   (SELECT COUNT(*) FROM kaigo_care_plans WHERE user_id = u.id) AS plans,
--   (SELECT COUNT(*) FROM kaigo_report_documents WHERE user_id = u.id AND report_type = 'care-plan-1') AS care_plan_1_docs,
--   (SELECT COUNT(*) FROM kaigo_support_records WHERE user_id = u.id) AS support_records
-- FROM kaigo_users u
-- ORDER BY u.name_kana;
