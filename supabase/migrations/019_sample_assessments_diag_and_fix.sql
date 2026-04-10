-- 019_sample_assessments_diag_and_fix.sql
-- Diagnostics + 確実に挿入される修正版 sample assessments
--
-- 前のマイグレーション 018 を実行しても画面に表示されない原因:
--   アセスメント画面は certification_id で絞り込んで一覧表示するため、
--   挿入したアセスメントの certification_id が NULL（利用者に認定情報が無い）
--   または、画面で選択中の認定タブと違う certification_id だった可能性があります。
--
-- このスクリプトは:
--   1. まず診断クエリで現状を確認できる (コメント部分を実行)
--   2. 既存のサンプルが NULL certification_id だった場合、認定情報があれば紐づけ直す
--   3. 認定情報が存在しない利用者には先に仮の認定情報を作成
--   4. 改めて全利用者×全認定期間でアセスメントを upsert する

-- ───────────────────────────────────────────────────────────────────────────
-- 診断（手動で実行して確認用 / 単独実行可）
-- ───────────────────────────────────────────────────────────────────────────
-- SELECT u.name, COUNT(a.id) AS assessment_count, COUNT(c.id) AS cert_count
-- FROM kaigo_users u
-- LEFT JOIN kaigo_assessments a ON a.user_id = u.id
-- LEFT JOIN kaigo_care_certifications c ON c.user_id = u.id
-- GROUP BY u.id, u.name
-- ORDER BY u.name_kana;
--
-- SELECT u.name, a.id, a.certification_id, a.assessment_date, a.status
-- FROM kaigo_assessments a
-- JOIN kaigo_users u ON u.id = a.user_id
-- ORDER BY u.name_kana;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. 認定情報が無い利用者に仮の認定情報を作成
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO kaigo_care_certifications (
  user_id,
  insurer_number,
  insured_number,
  care_level,
  certification_date,
  start_date,
  end_date,
  status
)
SELECT
  u.id,
  '290001',
  LPAD(ROW_NUMBER() OVER (ORDER BY u.created_at)::TEXT, 10, '0'),
  '要介護2',
  CURRENT_DATE - INTERVAL '60 days',
  CURRENT_DATE - INTERVAL '30 days',
  CURRENT_DATE + INTERVAL '335 days',
  'active'
FROM kaigo_users u
WHERE NOT EXISTS (
  SELECT 1 FROM kaigo_care_certifications c WHERE c.user_id = u.id
);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. 既存のサンプル（certification_id が NULL）に認定情報を紐づけ
-- ───────────────────────────────────────────────────────────────────────────
UPDATE kaigo_assessments a
SET certification_id = (
  SELECT c.id FROM kaigo_care_certifications c
  WHERE c.user_id = a.user_id
  ORDER BY c.start_date DESC
  LIMIT 1
)
WHERE a.certification_id IS NULL
  AND EXISTS (
    SELECT 1 FROM kaigo_care_certifications c WHERE c.user_id = a.user_id
  );

-- ───────────────────────────────────────────────────────────────────────────
-- 3. アセスメントが無い利用者に認定期間ごとにサンプルアセスメントを挿入
-- ───────────────────────────────────────────────────────────────────────────
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
  CURRENT_DATE - INTERVAL '7 days',
  'ケアマネジャー（サンプル）',

  '長男家族と同居。日中は長男夫婦が就労のため本人1人で過ごす時間が多い。週末は同居家族と過ごす。',
  '近隣に住む長女が週1回程度訪問し、買い物や通院の付き添いを行っている。民生委員による見守りも月1回程度ある。',
  '訪問介護（週2回：身体介護・生活援助）、通所介護（週2回）、福祉用具貸与（歩行器・手すり）',

  '戸建住宅（持家）',
  '築25年の木造2階建て。本人の居室は1階和室。段差は玄関・浴室に一部あり。トイレは洋式、手すり設置済み。',
  '浴室の床が滑りやすく転倒リスクあり。玄関の上り框の段差が大きく、昇降に不安がある。',

  CASE
    WHEN c.care_level IN ('要介護3','要介護4','要介護5')
      THEN '高血圧症、変形性膝関節症あり。慢性的な膝の痛みにより歩行に支障。昨年軽度の脳梗塞の既往あり、左半身にわずかな麻痺が残る。'
    WHEN c.care_level IN ('要介護1','要介護2')
      THEN '高血圧症、糖尿病あり。服薬管理中。軽度の膝関節症があり、長距離の歩行は困難。'
    ELSE '高血圧症あり。概ね安定している。定期的な受診と服薬で健康状態を維持している。'
  END,
  '内科：月1回（〇〇クリニック）、整形外科：月2回（△△整形外科）',
  '降圧剤、胃薬、鎮痛剤（頓服）',

  CASE
    WHEN c.care_level IN ('要介護3','要介護4','要介護5') THEN '一部介助'
    WHEN c.care_level IN ('要介護1','要介護2') THEN '見守り'
    ELSE '自立'
  END,
  '屋内は歩行器を使用して自力で移動可能。屋外は介助が必要。',

  '自立',
  '普通食を摂取。咀嚼・嚥下に問題なし。食事量はやや少なめ。',

  CASE
    WHEN c.care_level IN ('要介護3','要介護4','要介護5') THEN '一部介助'
    WHEN c.care_level IN ('要介護1','要介護2') THEN '見守り'
    ELSE '自立'
  END,
  '日中は自力でトイレへ移動。夜間はポータブルトイレ使用。',

  CASE
    WHEN c.care_level IN ('要介護3','要介護4','要介護5') THEN '一部介助'
    WHEN c.care_level IN ('要介護1','要介護2') THEN '一部介助'
    ELSE '見守り'
  END,
  '訪問介護・通所介護で入浴介助を受けている。自宅入浴は転倒リスクあり。',

  CASE
    WHEN c.care_level IN ('要介護3','要介護4','要介護5') THEN '一部介助'
    ELSE '自立'
  END,
  '上衣の着脱はほぼ自立。ズボン類の着脱に時間を要する。',

  '自立',
  '洗顔・歯磨き・髭剃りは自立。整髪もほぼ自立。',

  '自立',
  '会話に問題なし。聴力は年齢相応。意思表示は明確にできる。',

  CASE
    WHEN c.care_level IN ('要介護3','要介護4','要介護5') THEN '見守り'
    ELSE '自立'
  END,
  '軽度の物忘れあり。日常生活への支障は限定的。',

  '一部介助', '一部介助', '一部介助', '一部介助', '見守り',

  '住み慣れた自宅で安心して暮らしたい。膝の痛みを和らげて、少しでも歩けるようになりたい。',
  '本人が安全に過ごせるよう、転倒予防と服薬管理をしっかりしてほしい。家族の負担軽減も必要。',
  '高齢に伴う身体機能の低下により、日常生活の一部に介助が必要な状態。認知機能は比較的保たれており、本人の意思表示も明確。家族の協力も得られているが、日中独居の時間があるため、訪問介護と通所介護を組み合わせて在宅生活を支援している。',
  '①転倒リスクへの対応（住環境整備・リハビリ）、②服薬管理の継続、③社会的交流の機会確保、④家族介護者のレスパイトケア',

  E'6:30 起床・洗面\n7:30 朝食\n9:00 通所介護（月・木）または訪問介護（火・金）\n12:00 昼食\n13:00 休憩・テレビ視聴\n15:00 おやつ\n17:00 家族帰宅・会話\n18:30 夕食\n20:00 入浴（通所日）\n21:30 就寝',

  'draft'
FROM kaigo_care_certifications c
WHERE NOT EXISTS (
  SELECT 1 FROM kaigo_assessments a
  WHERE a.user_id = c.user_id AND a.certification_id = c.id
);

-- ───────────────────────────────────────────────────────────────────────────
-- 確認: 各利用者のアセスメント件数
-- ───────────────────────────────────────────────────────────────────────────
-- SELECT u.name, COUNT(a.id) AS assessment_count
-- FROM kaigo_users u
-- LEFT JOIN kaigo_assessments a ON a.user_id = u.id
-- GROUP BY u.id, u.name
-- ORDER BY u.name_kana;
