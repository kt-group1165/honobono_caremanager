-- 020_relink_sample_assessments.sql
-- サンプルアセスメントが古い認定情報に紐づいていて、現在表示中の認定タブと
-- 違うため画面に出ない問題への対応。
--
-- サンプルデータ (assessor_name = 'ケアマネジャー（サンプル）') を、
-- 各利用者の最新の認定情報に強制的に再紐づけする。

UPDATE kaigo_assessments a
SET certification_id = (
  SELECT c.id FROM kaigo_care_certifications c
  WHERE c.user_id = a.user_id
  ORDER BY c.start_date DESC
  LIMIT 1
)
WHERE a.assessor_name = 'ケアマネジャー（サンプル）'
  AND EXISTS (
    SELECT 1 FROM kaigo_care_certifications c WHERE c.user_id = a.user_id
  );

-- ───────────────────────────────────────────────────────────────────────────
-- 確認: 各利用者のサンプルアセスメントが、現在の最新認定に紐づいているか
-- ───────────────────────────────────────────────────────────────────────────
-- SELECT
--   u.name,
--   a.id AS assessment_id,
--   c.care_level,
--   c.start_date,
--   c.end_date,
--   CASE
--     WHEN a.certification_id = (
--       SELECT c2.id FROM kaigo_care_certifications c2
--       WHERE c2.user_id = u.id ORDER BY c2.start_date DESC LIMIT 1
--     ) THEN '✓ 最新の認定'
--     ELSE '✗ 古い認定'
--   END AS status
-- FROM kaigo_users u
-- JOIN kaigo_assessments a ON a.user_id = u.id
-- LEFT JOIN kaigo_care_certifications c ON c.id = a.certification_id
-- WHERE a.assessor_name = 'ケアマネジャー（サンプル）'
-- ORDER BY u.name_kana;
