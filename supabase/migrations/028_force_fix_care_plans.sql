-- 028_force_fix_care_plans.sql
-- 027 は certification_id が NULL のレコードを更新できなかった
-- (FROM kaigo_care_certifications c で INNER JOIN しているため)
--
-- このマイグレーションは：
-- 1. certification_id が NULL のサンプル計画書を最新の認定に紐づけ直す
-- 2. その上で全ての care-plan-1/2/3 を改めて UPDATE する
--    (LEFT JOIN で certification_id 不問)

-- ───────────────────────────────────────────────────────────────────────────
-- Step 1: certification_id NULL のサンプルに最新認定を紐づけ
-- ───────────────────────────────────────────────────────────────────────────
UPDATE kaigo_report_documents d
SET certification_id = (
  SELECT c.id FROM kaigo_care_certifications c
  WHERE c.user_id = d.user_id
  ORDER BY c.start_date DESC
  LIMIT 1
)
WHERE d.report_type IN ('care-plan-1', 'care-plan-2', 'care-plan-3')
  AND d.certification_id IS NULL
  AND EXISTS (
    SELECT 1 FROM kaigo_care_certifications c WHERE c.user_id = d.user_id
  );

-- ───────────────────────────────────────────────────────────────────────────
-- Step 2: 第1表 強制 UPDATE (LEFT JOIN なので cert なくても動く)
-- ───────────────────────────────────────────────────────────────────────────
UPDATE kaigo_report_documents d
SET content = jsonb_build_object(
  'plan_type', '初回',
  'cert_status', '認定済',
  'creator_name', 'ケアマネジャー（サンプル）',
  'office_name', '居宅介護支援事業所（サンプル）',
  'user_name', u.name,
  'birth_date', u.birth_date::text,
  'address', COALESCE(u.address, ''),
  'care_level', COALESCE(c.care_level, '要介護2'),
  'cert_period', COALESCE(c.start_date::text || '〜' || c.end_date::text, ''),
  'creation_date', (CURRENT_DATE - INTERVAL '7 days')::text,
  'initial_creation_date', (CURRENT_DATE - INTERVAL '180 days')::text,
  'issue_analysis',
    '本人は「' ||
    CASE
      WHEN c.care_level IN ('要介護4','要介護5') THEN '住み慣れた自宅で家族と一緒に過ごしたい'
      WHEN c.care_level IN ('要介護2','要介護3') THEN '膝の痛みを和らげて、自分のことは自分でしたい'
      ELSE '自立した生活を続けたい'
    END ||
    '」と希望されている。家族は本人の希望を尊重しつつ、安全な在宅生活の継続を望んでいる。' ||
    E'\n\n身体機能の低下により日常生活の一部に介助が必要だが、認知機能は保たれており本人の意欲も高い。' ||
    '転倒予防、入浴介助、社会参加の機会確保が課題となっている。',
  'review_opinion', '生活機能の維持・改善のため、適切な介護サービスの利用が望まれる。',
  'overall_policy',
    '本人の意欲を尊重しつつ、生活機能の維持・向上を図る。' ||
    E'\n①転倒予防のため福祉用具と通所介護でリハビリを継続' ||
    E'\n②入浴介助で清潔を保ち、皮膚状態を良好に保つ' ||
    E'\n③通所介護で社会参加の機会を確保し、認知機能の維持を図る' ||
    E'\n④家族の介護負担軽減のため、レスパイト的なサービス利用を検討',
  'living_support_reason', ''
)
FROM kaigo_users u
LEFT JOIN kaigo_care_certifications c ON c.user_id = u.id
  AND c.start_date = (
    SELECT MAX(c2.start_date) FROM kaigo_care_certifications c2 WHERE c2.user_id = u.id
  )
WHERE d.user_id = u.id
  AND d.report_type = 'care-plan-1';

-- ───────────────────────────────────────────────────────────────────────────
-- Step 3: 第2表 強制 UPDATE
-- ───────────────────────────────────────────────────────────────────────────
UPDATE kaigo_report_documents d
SET content = jsonb_build_object(
  'user_name', u.name,
  'creation_date', (CURRENT_DATE - INTERVAL '7 days')::text,
  'needs_blocks', jsonb_build_array(
    jsonb_build_object(
      'needs', '転倒せずに自宅内を安全に移動できるようになりたい',
      'long_term_goal', '自宅内を歩行器で安全に移動できるようになる',
      'long_term_period',
        COALESCE(c.start_date::text || '〜' || c.end_date::text, '令和6年4月〜令和7年3月'),
      'goals', jsonb_build_array(
        jsonb_build_object(
          'short_term_goal', '下肢筋力を維持し、転倒なく歩行できる',
          'short_term_period',
            COALESCE(c.start_date::text || '〜' || (c.start_date + INTERVAL '6 months')::date::text, '令和6年4月〜令和6年9月'),
          'services', jsonb_build_array(
            jsonb_build_object(
              'content', '通所介護にて機能訓練・入浴介助',
              'insurance_flag', '○',
              'type', '通所介護',
              'provider', '〇〇デイサービスセンター',
              'frequency', '週2回',
              'period', COALESCE(c.start_date::text || '〜' || c.end_date::text, '')
            ),
            jsonb_build_object(
              'content', '歩行器の貸与',
              'insurance_flag', '○',
              'type', '福祉用具貸与',
              'provider', '△△福祉用具',
              'frequency', '常時',
              'period', COALESCE(c.start_date::text || '〜' || c.end_date::text, '')
            )
          )
        )
      )
    ),
    jsonb_build_object(
      'needs', '入浴時に転倒しないよう支援が必要',
      'long_term_goal', '安全に入浴できる',
      'long_term_period',
        COALESCE(c.start_date::text || '〜' || c.end_date::text, ''),
      'goals', jsonb_build_array(
        jsonb_build_object(
          'short_term_goal', '週2回の入浴介助で清潔を保持する',
          'short_term_period',
            COALESCE(c.start_date::text || '〜' || (c.start_date + INTERVAL '6 months')::date::text, ''),
          'services', jsonb_build_array(
            jsonb_build_object(
              'content', '訪問介護による身体介護（入浴介助）',
              'insurance_flag', '○',
              'type', '訪問介護',
              'provider', '〇〇訪問介護ステーション',
              'frequency', '週2回',
              'period', COALESCE(c.start_date::text || '〜' || c.end_date::text, '')
            )
          )
        )
      )
    )
  )
)
FROM kaigo_users u
LEFT JOIN kaigo_care_certifications c ON c.user_id = u.id
  AND c.start_date = (
    SELECT MAX(c2.start_date) FROM kaigo_care_certifications c2 WHERE c2.user_id = u.id
  )
WHERE d.user_id = u.id
  AND d.report_type = 'care-plan-2';

-- ───────────────────────────────────────────────────────────────────────────
-- Step 4: 第3表 強制 UPDATE
-- ───────────────────────────────────────────────────────────────────────────
UPDATE kaigo_report_documents d
SET content = jsonb_build_object(
  'user_name', u.name,
  'creation_date', (CURRENT_DATE - INTERVAL '7 days')::text,
  'care_level', COALESCE(c.care_level, '要介護2'),
  'plan_period', COALESCE(c.start_date::text || '〜' || c.end_date::text, ''),
  'schedule', jsonb_build_object(
    'h08', jsonb_build_object(
      'mon', '通所介護(送迎)', 'tue', '訪問介護(身体)', 'wed', '',
      'thu', '通所介護(送迎)', 'fri', '訪問介護(身体)', 'sat', '', 'sun', ''
    ),
    'h10', jsonb_build_object(
      'mon', '通所介護', 'tue', '', 'wed', '',
      'thu', '通所介護', 'fri', '', 'sat', '', 'sun', ''
    ),
    'h14', jsonb_build_object(
      'mon', '通所介護(入浴)', 'tue', '', 'wed', '',
      'thu', '通所介護(入浴)', 'fri', '', 'sat', '', 'sun', ''
    ),
    'h16', jsonb_build_object(
      'mon', '通所介護(送迎)', 'tue', '', 'wed', '',
      'thu', '通所介護(送迎)', 'fri', '', 'sat', '', 'sun', ''
    )
  ),
  'daily_activities',
    E'6:30 起床・洗面\n7:30 朝食\n9:00 通所介護または訪問介護\n12:00 昼食\n13:00 休憩\n15:00 おやつ\n18:30 夕食\n20:00 入浴\n21:30 就寝',
  'other_services', '福祉用具貸与（歩行器）'
)
FROM kaigo_users u
LEFT JOIN kaigo_care_certifications c ON c.user_id = u.id
  AND c.start_date = (
    SELECT MAX(c2.start_date) FROM kaigo_care_certifications c2 WHERE c2.user_id = u.id
  )
WHERE d.user_id = u.id
  AND d.report_type = 'care-plan-3';
