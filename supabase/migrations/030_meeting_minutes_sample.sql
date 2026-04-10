-- 030_meeting_minutes_sample.sql
-- 会議録（第4表 サービス担当者会議の要点）のサンプルデータを投入
-- kaigo_report_documents.report_type = 'meeting-minutes'

INSERT INTO kaigo_report_documents (
  user_id, certification_id, care_plan_id, report_type, title, content, status
)
SELECT
  u.id,
  (SELECT c.id FROM kaigo_care_certifications c
   WHERE c.user_id = u.id ORDER BY c.start_date DESC LIMIT 1),
  (SELECT p.id FROM kaigo_care_plans p
   WHERE p.user_id = u.id ORDER BY p.start_date DESC LIMIT 1),
  'meeting-minutes',
  'サービス担当者会議の要点　' || (CURRENT_DATE - INTERVAL '50 days')::text,
  jsonb_build_object(
    'meeting_date', (CURRENT_DATE - INTERVAL '50 days')::text,
    'location', u.name || ' 様 ご自宅',
    'time_range', '14:00〜15:30',
    'session_number', '第1回',
    'creator_name', 'ケアマネジャー（サンプル）',
    'attendees', jsonb_build_array(
      jsonb_build_object('affiliation', '居宅介護支援事業所', 'name', 'ケアマネジャー（サンプル）'),
      jsonb_build_object('affiliation', '訪問介護事業所', 'name', '訪問介護 サ責'),
      jsonb_build_object('affiliation', '通所介護事業所', 'name', 'デイサービス 相談員'),
      jsonb_build_object('affiliation', '福祉用具事業所', 'name', '福祉用具 専門員'),
      jsonb_build_object('affiliation', '主治医', 'name', '内科医師'),
      jsonb_build_object('affiliation', '', 'name', ''),
      jsonb_build_object('affiliation', '', 'name', ''),
      jsonb_build_object('affiliation', '', 'name', ''),
      jsonb_build_object('affiliation', '', 'name', '')
    ),
    'self_attended', true,
    'family_attended', true,
    'family_relationship', '長男',
    'remarks', '本人の希望と家族の介護負担軽減について話し合った。',
    'topics',
      '1. 居宅サービス計画の説明と同意' || E'\n' ||
      '2. 各サービスの内容と頻度' || E'\n' ||
      '3. 短期目標・長期目標の確認' || E'\n' ||
      '4. 緊急時の連絡体制',
    'discussion',
      'ケアマネジャーより居宅サービス計画案を説明。' || E'\n' ||
      '・訪問介護: 週2回（火金）、身体介護(入浴介助)を中心に' || E'\n' ||
      '・通所介護: 週2回（月木）、機能訓練・入浴・社会参加' || E'\n' ||
      '・福祉用具: 歩行器の貸与' || E'\n\n' ||
      '訪問介護サ責より、入浴時の動線や手すりの位置確認の重要性について発言。' || E'\n' ||
      'デイサービス相談員より、レクリエーションへの参加意欲が高い旨報告。' || E'\n' ||
      '福祉用具専門員より、室内移動の安全確認と歩行器の調整について説明。' || E'\n' ||
      '主治医からは服薬管理の継続と転倒予防の重要性について指導あり。',
    'conclusion',
      '上記居宅サービス計画について、本人・家族を含む全出席者の合意を得た。' || E'\n' ||
      '計画開始日: ' || (CURRENT_DATE - INTERVAL '49 days')::text || E'\n' ||
      'モニタリングは月1回ケアマネジャーが訪問して実施することとした。',
    'remaining_issues',
      '①入浴時の安全確保について継続的な見守り' || E'\n' ||
      '②家族の介護負担状況の定期的な確認' || E'\n' ||
      '次回開催時期: 状況変化時または3ヶ月後を目処に再開催'
  ),
  'completed'
FROM kaigo_users u
WHERE NOT EXISTS (
  SELECT 1 FROM kaigo_report_documents d
  WHERE d.user_id = u.id AND d.report_type = 'meeting-minutes'
);
