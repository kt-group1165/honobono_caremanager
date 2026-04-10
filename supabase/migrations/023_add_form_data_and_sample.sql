-- 023_add_form_data_and_sample.sql
-- form_data JSONB カラムを追加し、サンプルアセスメントに投入する。
-- アプリのコードは form_data を参照しているのに、これまでマイグレーションで
-- 作成されていなかった。

-- 1. form_data カラム追加
ALTER TABLE kaigo_assessments
  ADD COLUMN IF NOT EXISTS form_data JSONB;

-- 2. サンプルアセスメントに form_data を投入
UPDATE kaigo_assessments
SET form_data = jsonb_build_object(
  'face_sheet', jsonb_build_object(
    'consultation_date', (CURRENT_DATE - INTERVAL '14 days')::text,
    'consultation_type', '訪問',
    'consultation_type_other', '',
    'first_receptionist', 'ケアマネジャー（サンプル）',
    'emergency_contact', jsonb_build_object(
      'name', '山田 一郎',
      'gender', '男',
      'age', '52',
      'relationship', '長男',
      'address', '同居',
      'tel', '03-1234-5678',
      'mobile', '090-1234-5678'
    ),
    'consultant', jsonb_build_object(
      'name', '山田 花子',
      'gender', '女',
      'age', '50',
      'relationship', '長女',
      'address', '近隣',
      'tel', '03-9876-5432',
      'mobile', '090-9876-5432'
    ),
    'referral_route', '〇〇病院 退院相談員 紹介',
    'plan_request_submission_date', (CURRENT_DATE - INTERVAL '10 days')::text,
    'consultation_content_user', '退院後も住み慣れた自宅で安心して暮らしたい。膝の痛みを和らげて歩けるようになりたい。',
    'consultation_content_family', '本人の希望を尊重しつつ、安全に過ごせるよう介護サービスを利用したい。家族の負担も軽減したい。',
    'life_history', '〇〇県出身。若い頃は会社員として勤務。退職後は趣味の園芸を楽しんでいた。配偶者との死別後、長男家族と同居。',
    'insurance_copay_ratio', '1割',
    'elderly_medical_copay_ratio', '1割',
    'high_cost_care_stage', '第3段階',
    'certification_status', '済',
    'certification_level', COALESCE((
      SELECT c.care_level FROM kaigo_care_certifications c
      WHERE c.id = kaigo_assessments.certification_id
      LIMIT 1
    ), '要介護2'),
    'certification_expected', '',
    'certification_date', COALESCE((
      SELECT c.certification_date::text FROM kaigo_care_certifications c
      WHERE c.id = kaigo_assessments.certification_id
      LIMIT 1
    ), ''),
    'physical_disability_cert', jsonb_build_object('has', false, 'grade', '', 'type', '', 'note', '', 'issue_date', ''),
    'intellectual_disability_cert', jsonb_build_object('has', false, 'level', '', 'note', '', 'issue_date', ''),
    'mental_disability_cert', jsonb_build_object('has', false, 'grade', '', 'note', '', 'issue_date', ''),
    'welfare_service_cert', '無',
    'self_support_medical_cert', '無',
    'disability_support_level', '',
    'daily_life_independence', jsonb_build_object(
      'physical', 'A1',
      'physical_judge_organization', '主治医意見書',
      'physical_judge_date', (CURRENT_DATE - INTERVAL '60 days')::text,
      'cognitive', '自立',
      'cognitive_judge_organization', '主治医意見書',
      'cognitive_judge_date', (CURRENT_DATE - INTERVAL '60 days')::text
    ),
    'first_assessment_date', (CURRENT_DATE - INTERVAL '7 days')::text
  ),

  'family_support', jsonb_build_object(
    'family_composition_diagram', '長男夫婦と同居。長女は近隣に在住。',
    'family_care_situation', '日中は長男夫婦が就労のため独居時間が長い。週末は同居家族と過ごす。',
    'family_members', jsonb_build_array(
      jsonb_build_object(
        'name', '山田 一郎',
        'is_primary_caregiver', true,
        'relationship', '長男',
        'living', '同',
        'employment', '有',
        'health_status', '健康',
        'notes', '主たる介護者'
      ),
      jsonb_build_object(
        'name', '山田 花子',
        'is_primary_caregiver', false,
        'relationship', '長女',
        'living', '別',
        'employment', '有',
        'health_status', '健康',
        'notes', '週1回程度訪問'
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
    'medical_history', '高血圧症（10年前〜）、変形性膝関節症（5年前〜）',
    'disability_location_notes', '左膝の慢性的な痛み',
    'height', '158',
    'weight', '52',
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
      ),
      jsonb_build_object(
        'disease_name', '変形性膝関節症',
        'has_medication', '有',
        'onset_date', '',
        'frequency_type', '定期',
        'frequency_unit', '月',
        'frequency_count', '2',
        'visit_type', '通院',
        'facility', '△△整形外科',
        'department', '整形外科',
        'doctor', '佐藤医師',
        'tel', '03-3333-4444',
        'notes', ''
      )
    ),
    'home_visit_available', jsonb_build_object('has', '無', 'facility', '', 'tel', ''),
    'emergency_hospital', jsonb_build_object('has', '有', 'facility', '〇〇総合病院', 'tel', '03-5555-6666'),
    'pharmacy', jsonb_build_object('has', '有', 'name', '〇〇薬局', 'tel', '03-7777-8888'),
    'life_considerations', '転倒予防、服薬管理'
  ),

  'summary', jsonb_build_object(
    'user_request', '住み慣れた自宅で安心して暮らしたい。',
    'family_request', '安全に過ごせるよう支援してほしい。',
    'overall_summary', '加齢に伴う身体機能の低下により日常生活の一部に介助が必要。認知機能は保たれており本人の意思表示も明確。',
    'issues', '①転倒リスク対応 ②服薬管理 ③社会的交流 ④家族レスパイト'
  ),

  'daily_schedule', jsonb_build_object(
    'schedule_text', E'6:30 起床・洗面\n7:30 朝食\n9:00 通所介護(月木) または 訪問介護(火金)\n12:00 昼食\n13:00 休憩\n15:00 おやつ\n17:00 家族帰宅\n18:30 夕食\n20:00 入浴\n21:30 就寝'
  )
)
WHERE assessor_name = 'ケアマネジャー（サンプル）';
