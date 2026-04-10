-- 031_monitoring_sample.sql
-- モニタリングシートのサンプルデータを投入
-- kaigo_monitoring_sheets + kaigo_monitoring_items

-- ───────────────────────────────────────────────────────────────────────────
-- Step 1: モニタリングシート本体を全利用者に作成
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO kaigo_monitoring_sheets (
  user_id, care_plan_id, monitoring_date, assessor_name, status
)
SELECT
  u.id,
  (SELECT p.id FROM kaigo_care_plans p
   WHERE p.user_id = u.id ORDER BY start_date DESC LIMIT 1),
  CURRENT_DATE - INTERVAL '10 days',
  'ケアマネジャー（サンプル）',
  'completed'
FROM kaigo_users u
WHERE NOT EXISTS (
  SELECT 1 FROM kaigo_monitoring_sheets m
  WHERE m.user_id = u.id AND m.assessor_name = 'ケアマネジャー（サンプル）'
);

-- ───────────────────────────────────────────────────────────────────────────
-- Step 2: モニタリング項目を各シートに 6 件投入
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO kaigo_monitoring_items (
  monitoring_sheet_id, item_number,
  short_term_goal, goal_period_start, goal_period_end,
  service_type, provider_name, implementation_status,
  user_satisfaction, family_satisfaction, satisfaction_comment,
  achievement, adl_change, plan_revision_needed, revision_reason
)
SELECT
  m.id,
  i.item_num,
  i.goal,
  m.monitoring_date - INTERVAL '60 days',
  m.monitoring_date + INTERVAL '120 days',
  i.svc,
  i.provider,
  i.impl,
  i.user_sat,
  i.family_sat,
  i.comment,
  i.achievement,
  i.adl,
  false,
  i.revision
FROM kaigo_monitoring_sheets m
CROSS JOIN (VALUES
  (1,
   '自宅内を歩行器で安全に移動できる',
   '通所介護', '〇〇デイサービスセンター',
   '週2回（月木）通所介護を利用。送迎時の歩行器使用も問題なく対応。リハビリで下肢筋力の維持を継続中。',
   '満足', '満足',
   '本人「楽しく通えている」、家族「安心して任せられる」とのこと。',
   'ほぼ達成', '良い変化',
   ''),
  (2,
   '週2回の入浴介助で清潔を保持できる',
   '訪問介護', '〇〇訪問介護ステーション',
   '週2回（火金）訪問介護による入浴介助。皮膚状態は良好。湯温・室温の調整も適切に実施。',
   '満足', '満足',
   '本人「気持ちいい」と発言あり。',
   '達成した', '不変',
   ''),
  (3,
   '転倒を予防し外出機会を確保する',
   '福祉用具貸与', '△△福祉用具',
   '歩行器の貸与継続中。月1回のメンテナンス実施。屋内外で活用できている。',
   '満足', '満足',
   '本人「歩行器のおかげで安心」とのこと。',
   '達成した', '良い変化',
   ''),
  (4,
   '社会参加の機会を確保し認知機能を維持する',
   '通所介護', '〇〇デイサービスセンター',
   'デイのレクリエーション・体操に積極的に参加。他の利用者との交流もあり。',
   '満足', '満足',
   '本人「友達ができた」、家族「表情が明るくなった」',
   '達成した', '良い変化',
   ''),
  (5,
   '服薬管理を継続し体調を安定させる',
   '医療連携', '〇〇クリニック',
   '内科月1回・整形外科月2回の通院継続。服薬カレンダーで自己管理が概ねできている。',
   '満足', '満足',
   '体調安定。血圧コントロール良好。',
   'ほぼ達成', '不変',
   ''),
  (6,
   '家族の介護負担軽減を図る',
   '通所介護', '〇〇デイサービスセンター',
   'デイ利用日は家族のレスパイト時間として活用できている。',
   '満足', '満足',
   '長男「自分の時間が確保できる」と発言。',
   '達成した', '良い変化',
   '')
) AS i(item_num, goal, svc, provider, impl, user_sat, family_sat, comment, achievement, adl, revision)
WHERE m.assessor_name = 'ケアマネジャー（サンプル）'
  AND NOT EXISTS (
    SELECT 1 FROM kaigo_monitoring_items mi
    WHERE mi.monitoring_sheet_id = m.id
  );
