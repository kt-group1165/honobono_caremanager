-- 021_assessment_per_cert.sql
-- 利用者が複数の認定情報を持っている場合に、認定ごとに1件ずつサンプル
-- アセスメントを作成する。
-- 既に該当 cert にアセスメントがあればスキップ。

INSERT INTO kaigo_assessments (
  user_id, certification_id, assessment_date, assessor_name,
  family_situation, informal_support, current_services,
  housing_type, housing_situation, housing_issues,
  health_condition, medical_visits, medications,
  mobility_status, mobility_notes,
  eating_status, eating_notes,
  toileting_status, toileting_notes,
  bathing_status, bathing_notes,
  dressing_status, dressing_notes,
  grooming_status, grooming_notes,
  communication_status, communication_notes,
  cognition_status, cognition_notes,
  cooking_status, cleaning_status, laundry_status, shopping_status, money_management_status,
  user_request, family_request, overall_summary, issues,
  daily_schedule,
  status
)
SELECT
  c.user_id,
  c.id AS certification_id,
  COALESCE(c.start_date, CURRENT_DATE - INTERVAL '7 days') AS assessment_date,
  'ケアマネジャー（サンプル）',
  '長男家族と同居。日中は本人1人で過ごす時間が多い。',
  '近隣に住む長女が週1回程度訪問。民生委員の見守りも月1回。',
  '訪問介護（週2回）、通所介護（週2回）、福祉用具貸与（歩行器・手すり）',
  '戸建住宅（持家）',
  '築25年の木造2階建て。本人居室は1階和室。',
  '浴室の床が滑りやすく転倒リスクあり。',
  CASE
    WHEN c.care_level IN ('要介護3','要介護4','要介護5') THEN '高血圧症、変形性膝関節症あり。'
    WHEN c.care_level IN ('要介護1','要介護2') THEN '高血圧症、糖尿病あり。'
    ELSE '高血圧症あり。概ね安定。'
  END,
  '内科：月1回、整形外科：月2回',
  '降圧剤、胃薬、鎮痛剤（頓服）',
  CASE
    WHEN c.care_level IN ('要介護3','要介護4','要介護5') THEN '一部介助'
    WHEN c.care_level IN ('要介護1','要介護2') THEN '見守り'
    ELSE '自立'
  END,
  '屋内は歩行器を使用。',
  '自立', '普通食を摂取。',
  CASE
    WHEN c.care_level IN ('要介護3','要介護4','要介護5') THEN '一部介助'
    WHEN c.care_level IN ('要介護1','要介護2') THEN '見守り'
    ELSE '自立'
  END,
  '日中は自力。夜間はポータブルトイレ。',
  CASE
    WHEN c.care_level IN ('要介護3','要介護4','要介護5') THEN '一部介助'
    WHEN c.care_level IN ('要介護1','要介護2') THEN '一部介助'
    ELSE '見守り'
  END,
  '訪問・通所で入浴介助。',
  CASE WHEN c.care_level IN ('要介護3','要介護4','要介護5') THEN '一部介助' ELSE '自立' END,
  '上衣はほぼ自立。',
  '自立', '洗顔・歯磨き・整髪は自立。',
  '自立', '会話に問題なし。',
  CASE WHEN c.care_level IN ('要介護3','要介護4','要介護5') THEN '見守り' ELSE '自立' END,
  '軽度の物忘れあり。',
  '一部介助', '一部介助', '一部介助', '一部介助', '見守り',
  '住み慣れた自宅で安心して暮らしたい。',
  '安全に過ごせるよう転倒予防と服薬管理をしっかり。',
  '高齢に伴う身体機能の低下により日常生活の一部に介助が必要。',
  '①転倒リスク対応 ②服薬管理 ③社会的交流 ④家族レスパイト',
  E'6:30 起床\n7:30 朝食\n9:00 通所/訪問\n12:00 昼食\n18:30 夕食\n21:30 就寝',
  'draft'
FROM kaigo_care_certifications c
WHERE NOT EXISTS (
  SELECT 1 FROM kaigo_assessments a
  WHERE a.user_id = c.user_id AND a.certification_id = c.id
);
