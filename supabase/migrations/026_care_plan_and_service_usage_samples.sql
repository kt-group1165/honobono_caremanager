-- 026_care_plan_and_service_usage_samples.sql
-- 計画書(第1表/第2表/第3表)と利用票・提供票(第6表)のサンプルデータを
-- kaigo_report_documents に投入する。
--
-- 全利用者×全認定期間に対して、未作成のものだけ INSERT (冪等)。

-- ───────────────────────────────────────────────────────────────────────────
-- 第1表 居宅サービス計画書（１）
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO kaigo_report_documents (
  user_id, certification_id, care_plan_id, report_type, title, content, status
)
SELECT
  c.user_id,
  c.id,
  (SELECT p.id FROM kaigo_care_plans p WHERE p.user_id = c.user_id ORDER BY start_date DESC LIMIT 1),
  'care-plan-1',
  '居宅サービス計画書（第1表）',
  jsonb_build_object(
    'user_name', u.name,
    'name_kana', u.name_kana,
    'birth_date', u.birth_date::text,
    'gender', u.gender,
    'address', COALESCE(u.address, ''),
    'phone', COALESCE(u.phone, ''),
    'plan_creation_date', (CURRENT_DATE - INTERVAL '7 days')::text,
    'first_creation_date', (CURRENT_DATE - INTERVAL '180 days')::text,
    'plan_type', '初回・紹介・継続　認定済・申請中',
    'creator_name', 'ケアマネジャー（サンプル）',
    'office_name', '居宅介護支援事業所（サンプル）',
    'office_address', '〇〇市〇〇町1-2-3',
    'office_tel', '03-1234-5678',
    'cert_period_start', c.start_date::text,
    'cert_period_end', c.end_date::text,
    'care_level', c.care_level,
    'support_intent_user',
      CASE
        WHEN c.care_level IN ('要介護4','要介護5') THEN '住み慣れた自宅で家族と一緒に過ごしたい。'
        WHEN c.care_level IN ('要介護2','要介護3') THEN '膝の痛みを和らげて、自分のことは自分でしたい。'
        WHEN c.care_level = '要介護1' THEN '社会との繋がりを保ちながら自宅生活を継続したい。'
        ELSE '健康に気をつけて、自立した生活を維持したい。'
      END,
    'support_intent_family', '本人の希望を尊重し、安全に在宅生活を継続できるよう支援したい。',
    'cert_committee_opinion', '生活機能の維持・改善のため、適切な介護サービスの利用が望まれる。',
    'overall_support_policy',
      CASE
        WHEN c.care_level IN ('要介護4','要介護5') THEN
          '在宅生活を継続しつつ、家族の介護負担を軽減する。リハビリと医療管理を継続。'
        ELSE
          '本人の意欲を引き出し、生活機能の維持・向上を図る。社会参加の機会を確保。'
      END,
    'emergency_contact', '長男：090-1234-5678（同居）',
    'agreement_date', (CURRENT_DATE - INTERVAL '7 days')::text
  ),
  'draft'
FROM kaigo_care_certifications c
JOIN kaigo_users u ON u.id = c.user_id
WHERE NOT EXISTS (
  SELECT 1 FROM kaigo_report_documents d
  WHERE d.user_id = c.user_id
    AND d.certification_id = c.id
    AND d.report_type = 'care-plan-1'
);

-- ───────────────────────────────────────────────────────────────────────────
-- 第2表 居宅サービス計画書（２）
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO kaigo_report_documents (
  user_id, certification_id, care_plan_id, report_type, title, content, status
)
SELECT
  c.user_id,
  c.id,
  (SELECT p.id FROM kaigo_care_plans p WHERE p.user_id = c.user_id ORDER BY start_date DESC LIMIT 1),
  'care-plan-2',
  '居宅サービス計画書（第2表）',
  jsonb_build_object(
    'user_name', u.name,
    'creation_date', (CURRENT_DATE - INTERVAL '7 days')::text,
    'needs_blocks', jsonb_build_array(
      jsonb_build_object(
        'needs', '転倒せずに自宅内を移動できるようになりたい',
        'long_term_goal', '自宅内を歩行器で安全に移動できる',
        'long_term_period',
          CONCAT(c.start_date::text, '〜', c.end_date::text),
        'short_term_goals', jsonb_build_array(
          jsonb_build_object(
            'short_goal', '下肢筋力を維持し、転倒なく歩行できる',
            'short_period', CONCAT(c.start_date::text, '〜',
              (c.start_date + INTERVAL '6 months')::date::text),
            'services', jsonb_build_array(
              jsonb_build_object(
                'content', '通所介護にて機能訓練・入浴介助',
                'insurance_flag', '○',
                'type', '通所介護',
                'provider', '〇〇デイサービスセンター',
                'frequency', '週2回',
                'period', CONCAT(c.start_date::text, '〜', c.end_date::text)
              ),
              jsonb_build_object(
                'content', '歩行器の貸与',
                'insurance_flag', '○',
                'type', '福祉用具貸与',
                'provider', '△△福祉用具',
                'frequency', '常時',
                'period', CONCAT(c.start_date::text, '〜', c.end_date::text)
              )
            )
          )
        )
      ),
      jsonb_build_object(
        'needs', '入浴時に転倒しないよう支援が必要',
        'long_term_goal', '安全に入浴できる',
        'long_term_period', CONCAT(c.start_date::text, '〜', c.end_date::text),
        'short_term_goals', jsonb_build_array(
          jsonb_build_object(
            'short_goal', '週2回の入浴介助で清潔保持',
            'short_period', CONCAT(c.start_date::text, '〜',
              (c.start_date + INTERVAL '6 months')::date::text),
            'services', jsonb_build_array(
              jsonb_build_object(
                'content', '訪問介護による身体介護（入浴介助）',
                'insurance_flag', '○',
                'type', '訪問介護',
                'provider', '〇〇訪問介護ステーション',
                'frequency', '週2回',
                'period', CONCAT(c.start_date::text, '〜', c.end_date::text)
              )
            )
          )
        )
      )
    )
  ),
  'draft'
FROM kaigo_care_certifications c
JOIN kaigo_users u ON u.id = c.user_id
WHERE NOT EXISTS (
  SELECT 1 FROM kaigo_report_documents d
  WHERE d.user_id = c.user_id
    AND d.certification_id = c.id
    AND d.report_type = 'care-plan-2'
);

-- ───────────────────────────────────────────────────────────────────────────
-- 第3表 週間サービス計画表
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO kaigo_report_documents (
  user_id, certification_id, care_plan_id, report_type, title, content, status
)
SELECT
  c.user_id,
  c.id,
  (SELECT p.id FROM kaigo_care_plans p WHERE p.user_id = c.user_id ORDER BY start_date DESC LIMIT 1),
  'care-plan-3',
  '週間サービス計画表（第3表）',
  jsonb_build_object(
    'user_name', u.name,
    'creation_date', (CURRENT_DATE - INTERVAL '7 days')::text,
    'care_level', c.care_level,
    'plan_period', CONCAT(c.start_date::text, '〜', c.end_date::text),
    'schedule', jsonb_build_object(
      'h08', jsonb_build_object(
        'mon', '通所介護(送迎)',
        'tue', '訪問介護(身体)',
        'wed', '',
        'thu', '通所介護(送迎)',
        'fri', '訪問介護(身体)',
        'sat', '',
        'sun', ''
      ),
      'h10', jsonb_build_object(
        'mon', '通所介護',
        'tue', '',
        'wed', '',
        'thu', '通所介護',
        'fri', '',
        'sat', '',
        'sun', ''
      ),
      'h14', jsonb_build_object(
        'mon', '通所介護(入浴)',
        'tue', '',
        'wed', '',
        'thu', '通所介護(入浴)',
        'fri', '',
        'sat', '',
        'sun', ''
      ),
      'h16', jsonb_build_object(
        'mon', '通所介護(送迎)',
        'tue', '',
        'wed', '',
        'thu', '通所介護(送迎)',
        'fri', '',
        'sat', '',
        'sun', ''
      )
    ),
    'daily_activities',
      E'起床・洗面\n食事(朝・昼・夕)\nレクリエーション\n入浴\n散歩\n就寝',
    'other_services', '福祉用具貸与（歩行器）'
  ),
  'draft'
FROM kaigo_care_certifications c
JOIN kaigo_users u ON u.id = c.user_id
WHERE NOT EXISTS (
  SELECT 1 FROM kaigo_report_documents d
  WHERE d.user_id = c.user_id
    AND d.certification_id = c.id
    AND d.report_type = 'care-plan-3'
);

-- ───────────────────────────────────────────────────────────────────────────
-- 第6表 サービス利用票・提供票
-- 認定期間とは独立に、当月分のみ作成 (1利用者1件)
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO kaigo_report_documents (
  user_id, certification_id, care_plan_id, report_type, report_month, title, content, status
)
SELECT
  u.id,
  (SELECT c.id FROM kaigo_care_certifications c
   WHERE c.user_id = u.id
   ORDER BY c.start_date DESC LIMIT 1),
  (SELECT p.id FROM kaigo_care_plans p WHERE p.user_id = u.id ORDER BY start_date DESC LIMIT 1),
  'service-usage',
  TO_CHAR(CURRENT_DATE, 'YYYY-MM'),
  'サービス利用票・提供票　' || TO_CHAR(CURRENT_DATE, 'YYYY年MM月'),
  jsonb_build_object(
    'insurer_number', '290001',
    'insured_number', '0000000000',
    'insurer_name', '〇〇市',
    'user_name', u.name,
    'care_level', (SELECT care_level FROM kaigo_care_certifications WHERE user_id = u.id ORDER BY start_date DESC LIMIT 1),
    'limit_amount',
      CASE (SELECT care_level FROM kaigo_care_certifications WHERE user_id = u.id ORDER BY start_date DESC LIMIT 1)
        WHEN '要支援1' THEN 5032
        WHEN '要支援2' THEN 10531
        WHEN '要介護1' THEN 16765
        WHEN '要介護2' THEN 19705
        WHEN '要介護3' THEN 27048
        WHEN '要介護4' THEN 30938
        WHEN '要介護5' THEN 36217
        ELSE 0
      END,
    'limit_period', '令和6年4月〜令和7年3月',
    'creation_date', (CURRENT_DATE - INTERVAL '5 days')::text,
    'submission_date', '',
    'services', jsonb_build_array(
      jsonb_build_object(
        'time', '09:00〜16:00',
        'content', '通所介護',
        'provider', '〇〇デイサービスセンター',
        'planned',
          (
            -- 月8回（月木）想定
            SELECT jsonb_agg(CASE WHEN i IN (1,4,8,11,15,18,22,25) THEN true ELSE false END)
            FROM generate_series(1, 31) AS i
          ),
        'actual',
          (
            SELECT jsonb_agg(CASE WHEN i IN (1,4,8,11,15,18,22,25) THEN true ELSE false END)
            FROM generate_series(1, 31) AS i
          )
      ),
      jsonb_build_object(
        'time', '10:00〜11:00',
        'content', '訪問介護(身体介護)',
        'provider', '〇〇訪問介護ステーション',
        'planned',
          (
            -- 月8回（火金）想定
            SELECT jsonb_agg(CASE WHEN i IN (2,5,9,12,16,19,23,26) THEN true ELSE false END)
            FROM generate_series(1, 31) AS i
          ),
        'actual',
          (
            SELECT jsonb_agg(CASE WHEN i IN (2,5,9,12,16,19,23,26) THEN true ELSE false END)
            FROM generate_series(1, 31) AS i
          )
      ),
      jsonb_build_object(
        'time', '常時',
        'content', '福祉用具貸与（歩行器）',
        'provider', '△△福祉用具',
        'planned',
          (SELECT jsonb_agg(true) FROM generate_series(1, 31)),
        'actual',
          (SELECT jsonb_agg(true) FROM generate_series(1, 31))
      )
    )
  ),
  'draft'
FROM kaigo_users u
WHERE NOT EXISTS (
  SELECT 1 FROM kaigo_report_documents d
  WHERE d.user_id = u.id
    AND d.report_type = 'service-usage'
    AND d.report_month = TO_CHAR(CURRENT_DATE, 'YYYY-MM')
);
