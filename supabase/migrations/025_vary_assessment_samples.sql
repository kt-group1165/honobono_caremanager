-- 025_vary_assessment_samples.sql
-- アセスメントサンプル(form_data)を利用者ごとに変化させる
-- 023 までは全員同じ内容だったので、利用者の名前・要介護度に応じて
-- 微調整したサンプルに置き換える。

UPDATE kaigo_assessments a
SET form_data = jsonb_build_object(
  'face_sheet', jsonb_build_object(
    'consultation_date', (CURRENT_DATE - INTERVAL '14 days')::text,
    'consultation_type', '訪問',
    'consultation_type_other', '',
    'first_receptionist', 'ケアマネジャー（サンプル）',
    'emergency_contact', jsonb_build_object(
      'name', u.name || ' 家族A',
      'gender',
        CASE WHEN substring(md5(u.id::text) FROM 1 FOR 1) IN ('0','1','2','3','4','5','6','7') THEN '男' ELSE '女' END,
      'age', (40 + (abs(hashtext(u.id::text)) % 30))::text,
      'relationship', '長男',
      'address', '同居',
      'tel', '03-' || lpad((abs(hashtext(u.id::text || 'tel1')) % 9999 + 1000)::text, 4, '0') || '-' || lpad((abs(hashtext(u.id::text || 'tel2')) % 9999 + 1000)::text, 4, '0'),
      'mobile', '090-' || lpad((abs(hashtext(u.id::text || 'mob1')) % 9999 + 1000)::text, 4, '0') || '-' || lpad((abs(hashtext(u.id::text || 'mob2')) % 9999 + 1000)::text, 4, '0')
    ),
    'consultant', jsonb_build_object(
      'name', u.name || ' 家族B',
      'gender', '女',
      'age', (38 + (abs(hashtext(u.id::text || 'b')) % 30))::text,
      'relationship', '長女',
      'address', '近隣',
      'tel', '',
      'mobile', '080-' || lpad((abs(hashtext(u.id::text || 'm1')) % 9999 + 1000)::text, 4, '0') || '-' || lpad((abs(hashtext(u.id::text || 'm2')) % 9999 + 1000)::text, 4, '0')
    ),
    'referral_route',
      CASE (abs(hashtext(u.id::text)) % 4)
        WHEN 0 THEN '〇〇病院 退院相談員 紹介'
        WHEN 1 THEN '地域包括支援センター 紹介'
        WHEN 2 THEN 'ご家族からの直接相談'
        ELSE '主治医からの紹介'
      END,
    'plan_request_submission_date', (CURRENT_DATE - INTERVAL '10 days')::text,
    'consultation_content_user',
      CASE
        WHEN c.care_level IN ('要介護4','要介護5') THEN '少しでも自分でできることを増やしたい。家族に負担をかけたくない。'
        WHEN c.care_level IN ('要介護2','要介護3') THEN '住み慣れた自宅で安心して暮らしたい。膝の痛みを和らげて歩けるようになりたい。'
        WHEN c.care_level IN ('要介護1') THEN 'できる限り自立した生活を続けたい。買い物や通院に困っている。'
        ELSE '体調を崩さず、これからも自宅で生活を続けたい。'
      END,
    'consultation_content_family',
      CASE
        WHEN c.care_level IN ('要介護4','要介護5') THEN '在宅介護を継続したいが家族の負担が大きい。レスパイトを希望。'
        WHEN c.care_level IN ('要介護2','要介護3') THEN '本人の希望を尊重しつつ、安全に過ごせるよう介護サービスを利用したい。'
        ELSE '本人ができることはなるべく自分でしてほしい。困った時のサポートを希望。'
      END,
    'life_history',
      u.name || ' 様。' ||
      CASE (abs(hashtext(u.id::text || 'hist')) % 4)
        WHEN 0 THEN '〇〇県出身。会社員として勤務後、退職。趣味は園芸。'
        WHEN 1 THEN '農家で育ち、長年農業に従事。現在は息子家族と同居。'
        WHEN 2 THEN '教員として勤務。退職後は地域のボランティア活動に参加。'
        ELSE '主婦として家庭を支えてきた。読書と手芸が趣味。'
      END,
    'insurance_copay_ratio', '1割',
    'elderly_medical_copay_ratio', '1割',
    'high_cost_care_stage',
      CASE (abs(hashtext(u.id::text)) % 4)
        WHEN 0 THEN '第2段階'
        WHEN 1 THEN '第3段階'
        WHEN 2 THEN '第4段階'
        ELSE '第3段階'
      END,
    'certification_status', '済',
    'certification_level', COALESCE(c.care_level, '要介護2'),
    'certification_expected', '',
    'certification_date', COALESCE(c.certification_date::text, ''),
    'physical_disability_cert', jsonb_build_object('has', false, 'grade', '', 'type', '', 'note', '', 'issue_date', ''),
    'intellectual_disability_cert', jsonb_build_object('has', false, 'level', '', 'note', '', 'issue_date', ''),
    'mental_disability_cert', jsonb_build_object('has', false, 'grade', '', 'note', '', 'issue_date', ''),
    'welfare_service_cert', '無',
    'self_support_medical_cert', '無',
    'disability_support_level', '',
    'daily_life_independence', jsonb_build_object(
      'physical',
        CASE
          WHEN c.care_level IN ('要介護4','要介護5') THEN 'B1'
          WHEN c.care_level IN ('要介護2','要介護3') THEN 'A2'
          WHEN c.care_level IN ('要介護1') THEN 'A1'
          ELSE 'J2'
        END,
      'physical_judge_organization', '主治医意見書',
      'physical_judge_date', (CURRENT_DATE - INTERVAL '60 days')::text,
      'cognitive',
        CASE
          WHEN c.care_level IN ('要介護4','要介護5') THEN 'IIa'
          WHEN c.care_level IN ('要介護2','要介護3') THEN 'I'
          ELSE '自立'
        END,
      'cognitive_judge_organization', '主治医意見書',
      'cognitive_judge_date', (CURRENT_DATE - INTERVAL '60 days')::text
    ),
    'first_assessment_date', (CURRENT_DATE - INTERVAL '7 days')::text
  ),

  'family_support', jsonb_build_object(
    'family_composition_diagram',
      CASE (abs(hashtext(u.id::text)) % 3)
        WHEN 0 THEN '長男夫婦と同居。長女は近隣在住。'
        WHEN 1 THEN '配偶者と二人暮らし。子は遠方。'
        ELSE '独居。長女が週2回訪問。'
      END,
    'family_care_situation',
      CASE (abs(hashtext(u.id::text)) % 3)
        WHEN 0 THEN '日中は長男夫婦が就労のため独居時間が長い。'
        WHEN 1 THEN '配偶者が高齢のため介護負担が大きい。'
        ELSE '独居だが家族の支援は安定している。'
      END,
    'family_members', jsonb_build_array(
      jsonb_build_object(
        'name', u.name || ' 家族A',
        'is_primary_caregiver', true,
        'relationship', '長男',
        'living', '同',
        'employment', '有',
        'health_status', '健康',
        'notes', '主たる介護者'
      )
    ),
    'informal_support', jsonb_build_array(
      jsonb_build_object('provider', '民生委員', 'content', '月1回見守り訪問', 'notes', '')
    ),
    'needed_support', jsonb_build_object(
      'content', '日中独居時の見守り、買い物支援',
      'provider', '訪問介護・通所介護',
      'notes', ''
    )
  ),

  'health', jsonb_build_object(
    'medical_history',
      CASE
        WHEN c.care_level IN ('要介護4','要介護5') THEN '高血圧症、変形性膝関節症、軽度脳梗塞既往。'
        WHEN c.care_level IN ('要介護2','要介護3') THEN '高血圧症、糖尿病、変形性膝関節症。'
        WHEN c.care_level IN ('要介護1') THEN '高血圧症、軽度の関節痛。'
        ELSE '高血圧症あり。概ね安定。'
      END,
    'disability_location_notes',
      CASE
        WHEN c.care_level IN ('要介護4','要介護5') THEN '左半身に軽度の麻痺あり'
        ELSE '左膝の慢性的な痛み'
      END,
    'height', (150 + (abs(hashtext(u.id::text || 'h')) % 20))::text,
    'weight', (45 + (abs(hashtext(u.id::text || 'w')) % 20))::text,
    'teeth', jsonb_build_object('status', jsonb_build_array('義歯（部分）')),
    'special_notes', '転倒に注意',
    'medical_visits', jsonb_build_array(
      jsonb_build_object(
        'disease_name', '高血圧症',
        'has_medication', '有',
        'onset_date', '',
        'frequency_type', '定期',
        'frequency_unit', '月',
        'frequency_count', '1',
        'visit_type', '通院',
        'facility', '〇〇クリニック',
        'department', '内科',
        'doctor', '田中医師',
        'tel', '03-1111-2222',
        'notes', ''
      )
    ),
    'home_visit_available', jsonb_build_object('has', '無', 'facility', '', 'tel', ''),
    'emergency_hospital', jsonb_build_object('has', '有', 'facility', '〇〇総合病院', 'tel', '03-5555-6666'),
    'pharmacy', jsonb_build_object('has', '有', 'name', '〇〇薬局', 'tel', '03-7777-8888'),
    'life_considerations', '転倒予防、服薬管理'
  ),

  'summary', jsonb_build_object(
    'user_request',
      CASE
        WHEN c.care_level IN ('要介護4','要介護5') THEN '少しでも自分でできることを増やしたい。'
        WHEN c.care_level IN ('要介護2','要介護3') THEN '住み慣れた自宅で安心して暮らしたい。'
        ELSE '自立した生活を続けたい。'
      END,
    'family_request',
      CASE
        WHEN c.care_level IN ('要介護4','要介護5') THEN '介護負担を軽減したい。レスパイトケアを希望。'
        ELSE '安全に過ごせるよう支援してほしい。'
      END,
    'overall_summary',
      u.name || ' 様。' ||
      CASE
        WHEN c.care_level IN ('要介護4','要介護5') THEN '中重度の介護を要する状態。家族支援と組み合わせて在宅生活を継続。'
        WHEN c.care_level IN ('要介護2','要介護3') THEN '日常生活の一部に介助が必要。認知機能は概ね保たれている。'
        ELSE '基本的に自立しているが、一部のIADLに支援が必要。'
      END,
    'issues', '①転倒リスク対応 ②服薬管理 ③社会的交流 ④家族レスパイト'
  ),

  'daily_schedule', jsonb_build_object(
    'schedule_text', E'6:30 起床・洗面\n7:30 朝食\n9:00 通所介護(月木) または 訪問介護(火金)\n12:00 昼食\n13:00 休憩\n15:00 おやつ\n17:00 家族帰宅\n18:30 夕食\n20:00 入浴\n21:30 就寝'
  )
)
FROM kaigo_users u
LEFT JOIN kaigo_care_certifications c ON c.id = a.certification_id
WHERE a.user_id = u.id
  AND a.assessor_name = 'ケアマネジャー（サンプル）';
