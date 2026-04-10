-- 018_sample_assessments.sql
-- 全利用者にサンプルのアセスメントデータを投入
-- 既にアセスメントがある利用者はスキップ

INSERT INTO kaigo_assessments (
  user_id,
  certification_id,
  assessment_date,
  assessor_name,

  -- 1. 家族状況・インフォーマルな支援
  family_situation,
  informal_support,

  -- 2. サービス利用状況
  current_services,

  -- 3. 住居等の状況
  housing_type,
  housing_situation,
  housing_issues,

  -- 4. 健康状態・受診等の状況
  health_condition,
  medical_visits,
  medications,

  -- 5. 基本動作
  mobility_status, mobility_notes,
  eating_status, eating_notes,
  toileting_status, toileting_notes,
  bathing_status, bathing_notes,
  dressing_status, dressing_notes,
  grooming_status, grooming_notes,
  communication_status, communication_notes,
  cognition_status, cognition_notes,

  -- 6. IADL
  cooking_status,
  cleaning_status,
  laundry_status,
  shopping_status,
  money_management_status,

  -- 7. 全体のまとめ
  user_request,
  family_request,
  overall_summary,
  issues,

  -- 8. 1日のスケジュール
  daily_schedule,

  status
)
SELECT
  u.id AS user_id,
  (SELECT c.id FROM kaigo_care_certifications c
   WHERE c.user_id = u.id
   ORDER BY c.start_date DESC
   LIMIT 1) AS certification_id,
  CURRENT_DATE - INTERVAL '7 days' AS assessment_date,
  'ケアマネジャー（サンプル）' AS assessor_name,

  -- 1. 家族状況
  '長男家族と同居。日中は長男夫婦が就労のため本人1人で過ごす時間が多い。週末は同居家族と過ごす。' AS family_situation,
  '近隣に住む長女が週1回程度訪問し、買い物や通院の付き添いを行っている。民生委員による見守りも月1回程度ある。' AS informal_support,

  -- 2. サービス利用状況
  '訪問介護（週2回：身体介護・生活援助）、通所介護（週2回）、福祉用具貸与（歩行器・手すり）' AS current_services,

  -- 3. 住居等の状況
  '戸建住宅（持家）' AS housing_type,
  '築25年の木造2階建て。本人の居室は1階和室。段差は玄関・浴室に一部あり。トイレは洋式、手すり設置済み。' AS housing_situation,
  '浴室の床が滑りやすく転倒リスクあり。玄関の上り框の段差が大きく、昇降に不安がある。' AS housing_issues,

  -- 4. 健康状態
  CASE
    WHEN (SELECT care_level FROM kaigo_care_certifications WHERE user_id = u.id ORDER BY start_date DESC LIMIT 1) IN ('要介護3','要介護4','要介護5')
      THEN '高血圧症、変形性膝関節症あり。慢性的な膝の痛みにより歩行に支障。昨年軽度の脳梗塞の既往あり、左半身にわずかな麻痺が残る。'
    WHEN (SELECT care_level FROM kaigo_care_certifications WHERE user_id = u.id ORDER BY start_date DESC LIMIT 1) IN ('要介護1','要介護2')
      THEN '高血圧症、糖尿病あり。服薬管理中。軽度の膝関節症があり、長距離の歩行は困難。'
    ELSE '高血圧症あり。概ね安定している。定期的な受診と服薬で健康状態を維持している。'
  END AS health_condition,
  '内科：月1回（〇〇クリニック）、整形外科：月2回（△△整形外科）' AS medical_visits,
  '降圧剤、胃薬、鎮痛剤（頓服）' AS medications,

  -- 5. 基本動作（要介護度に応じて変化させる）
  CASE
    WHEN (SELECT care_level FROM kaigo_care_certifications WHERE user_id = u.id ORDER BY start_date DESC LIMIT 1) IN ('要介護3','要介護4','要介護5') THEN '一部介助'
    WHEN (SELECT care_level FROM kaigo_care_certifications WHERE user_id = u.id ORDER BY start_date DESC LIMIT 1) IN ('要介護1','要介護2') THEN '見守り'
    ELSE '自立'
  END AS mobility_status,
  '屋内は歩行器を使用して自力で移動可能。屋外は介助が必要。' AS mobility_notes,

  '自立' AS eating_status,
  '普通食を摂取。咀嚼・嚥下に問題なし。食事量はやや少なめ。' AS eating_notes,

  CASE
    WHEN (SELECT care_level FROM kaigo_care_certifications WHERE user_id = u.id ORDER BY start_date DESC LIMIT 1) IN ('要介護3','要介護4','要介護5') THEN '一部介助'
    WHEN (SELECT care_level FROM kaigo_care_certifications WHERE user_id = u.id ORDER BY start_date DESC LIMIT 1) IN ('要介護1','要介護2') THEN '見守り'
    ELSE '自立'
  END AS toileting_status,
  '日中は自力でトイレへ移動。夜間はポータブルトイレ使用。' AS toileting_notes,

  CASE
    WHEN (SELECT care_level FROM kaigo_care_certifications WHERE user_id = u.id ORDER BY start_date DESC LIMIT 1) IN ('要介護3','要介護4','要介護5') THEN '一部介助'
    WHEN (SELECT care_level FROM kaigo_care_certifications WHERE user_id = u.id ORDER BY start_date DESC LIMIT 1) IN ('要介護1','要介護2') THEN '一部介助'
    ELSE '見守り'
  END AS bathing_status,
  '訪問介護・通所介護で入浴介助を受けている。自宅入浴は転倒リスクあり。' AS bathing_notes,

  CASE
    WHEN (SELECT care_level FROM kaigo_care_certifications WHERE user_id = u.id ORDER BY start_date DESC LIMIT 1) IN ('要介護3','要介護4','要介護5') THEN '一部介助'
    ELSE '自立'
  END AS dressing_status,
  '上衣の着脱はほぼ自立。ズボン類の着脱に時間を要する。' AS dressing_notes,

  '自立' AS grooming_status,
  '洗顔・歯磨き・髭剃りは自立。整髪もほぼ自立。' AS grooming_notes,

  '自立' AS communication_status,
  '会話に問題なし。聴力は年齢相応。意思表示は明確にできる。' AS communication_notes,

  CASE
    WHEN (SELECT care_level FROM kaigo_care_certifications WHERE user_id = u.id ORDER BY start_date DESC LIMIT 1) IN ('要介護3','要介護4','要介護5') THEN '見守り'
    ELSE '自立'
  END AS cognition_status,
  '軽度の物忘れあり。日常生活への支障は限定的。' AS cognition_notes,

  -- 6. IADL
  '一部介助' AS cooking_status,
  '一部介助' AS cleaning_status,
  '一部介助' AS laundry_status,
  '一部介助' AS shopping_status,
  '見守り' AS money_management_status,

  -- 7. 全体のまとめ
  '住み慣れた自宅で安心して暮らしたい。膝の痛みを和らげて、少しでも歩けるようになりたい。' AS user_request,
  '本人が安全に過ごせるよう、転倒予防と服薬管理をしっかりしてほしい。家族の負担軽減も必要。' AS family_request,
  '高齢に伴う身体機能の低下により、日常生活の一部に介助が必要な状態。認知機能は比較的保たれており、本人の意思表示も明確。家族の協力も得られているが、日中独居の時間があるため、訪問介護と通所介護を組み合わせて在宅生活を支援している。' AS overall_summary,
  '①転倒リスクへの対応（住環境整備・リハビリ）、②服薬管理の継続、③社会的交流の機会確保、④家族介護者のレスパイトケア' AS issues,

  -- 8. 1日のスケジュール
  E'6:30 起床・洗面\n7:30 朝食\n9:00 通所介護（月・木）または訪問介護（火・金）\n12:00 昼食\n13:00 休憩・テレビ視聴\n15:00 おやつ\n17:00 家族帰宅・会話\n18:30 夕食\n20:00 入浴（通所日）\n21:30 就寝' AS daily_schedule,

  'draft' AS status
FROM kaigo_users u
WHERE NOT EXISTS (
  SELECT 1 FROM kaigo_assessments a WHERE a.user_id = u.id
);
