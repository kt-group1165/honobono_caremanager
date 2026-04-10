-- 024_support_records_and_sample.sql
-- 1. kaigo_support_records に care_plan_id カラムを追加
-- 2. 全利用者にサンプル支援経過レコードを投入

-- ───────────────────────────────────────────────────────────────────────────
-- 1. care_plan_id 追加
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE kaigo_support_records
  ADD COLUMN IF NOT EXISTS care_plan_id UUID REFERENCES kaigo_care_plans(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_kaigo_support_records_plan
  ON kaigo_support_records(care_plan_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. サンプル支援経過レコードを投入
-- 既にサンプルがある利用者はスキップ（冪等）
-- category は CHECK 制約: 電話/訪問/来所/メール/FAX/カンファレンス/
--                       サービス担当者会議/モニタリング/その他
-- ───────────────────────────────────────────────────────────────────────────

WITH user_plans AS (
  SELECT
    u.id AS user_id,
    (SELECT id FROM kaigo_care_plans p WHERE p.user_id = u.id ORDER BY start_date DESC LIMIT 1) AS plan_id
  FROM kaigo_users u
  WHERE NOT EXISTS (
    SELECT 1 FROM kaigo_support_records sr
    WHERE sr.user_id = u.id AND sr.staff_name = 'ケアマネジャー（サンプル）'
  )
)
INSERT INTO kaigo_support_records (user_id, care_plan_id, record_date, record_time, category, content, staff_name)
SELECT user_id, plan_id, record_date, record_time::time, category, content, 'ケアマネジャー（サンプル）'
FROM user_plans up
CROSS JOIN (VALUES
  ((CURRENT_DATE - INTERVAL '60 days')::date, '10:00', '訪問',
   '初回訪問。利用者本人と長男夫婦に同席いただきケアマネジャーとして自己紹介。介護保険サービスの利用希望をヒアリングし、現在の生活状況や困りごとを伺った。膝の痛みで歩行が不安定、入浴介助のニーズが高いことを確認。'),
  ((CURRENT_DATE - INTERVAL '55 days')::date, '14:00', '訪問',
   '居宅訪問にてアセスメントを実施。基本動作・IADL・認知機能・社会参加・住環境の各項目を確認。本人の意向「住み慣れた自宅で安心して暮らしたい」を尊重したケアプラン作成方針を共有。'),
  ((CURRENT_DATE - INTERVAL '50 days')::date, '15:30', 'サービス担当者会議',
   'サービス担当者会議を本人宅にて開催。出席者: 本人、長男、訪問介護事業所サービス提供責任者、通所介護事業所相談員、ケアマネジャー。長期目標・短期目標、各サービスの内容と頻度について合意形成。次回モニタリング日程を確認。'),
  ((CURRENT_DATE - INTERVAL '40 days')::date, '11:00', '電話',
   '訪問介護事業所より連絡。サービス開始後のご本人の状況について報告あり。入浴介助時に膝の痛みが強いため、福祉用具の追加検討の提案あり。次回訪問時に確認することとした。'),
  ((CURRENT_DATE - INTERVAL '30 days')::date, '13:30', 'モニタリング',
   'モニタリング訪問。本人および長男に面談。サービス利用開始から1ヶ月の状況を確認。「通所介護のレクリエーションが楽しい」と本人より発言あり。膝の痛みについては整形外科の受診継続中。短期目標の達成度は概ね良好。'),
  ((CURRENT_DATE - INTERVAL '20 days')::date, '09:30', '電話',
   '長女様より連絡。本人の体調が良好で、家族の負担感も軽減しているとの報告。今後も現状のサービス内容を継続希望。次回訪問時にあらためて状況確認することを伝えた。'),
  ((CURRENT_DATE - INTERVAL '10 days')::date, '14:00', 'モニタリング',
   'モニタリング訪問。サービス利用状況と目標達成度を評価。短期目標「自宅内を歩行器で安全に移動できる」はおおむね達成。長期目標達成に向けて引き続き支援継続。次回モニタリング予定: 来月。')
) AS s(record_date, record_time, category, content);
