-- 訪問介護計画書 v2 (kaigo_houmon_care_plans 拡張)  2026-08-07
--
-- 背景:
--   v1 は「長期目標 / 短期目標 (単一 TEXT)」+「services[] (区分・頻度・時間帯・内容)」だけの
--   簡易版だった。ほのぼの NEXT「訪問介護計画書作成編」の流れ
--     Ⅰ カンファレンス → Ⅱ 計画書 → Ⅱ-2 詳細計画(手順書) → Ⅲ 実施記録
--   および実運用の訪問介護計画書 (指定基準 第28条) の記載項目に合わせて拡張する。
--
-- 変更点:
--   1) ニーズ→長期目標(期間)→短期目標(期間) を goals JSONB (行の配列) に構造化
--      → 居宅サービス計画書 第2表 (needs_blocks) からそのまま取込できる形
--   2) サービス内容を weekly_services JSONB (曜日・開始/終了時刻・区分・援助内容・留意点) に
--      → 週間サービス計画として印刷、手順書 (kaigo_visit_procedure_documents) へ引き継ぐ形
--   3) 本人/家族の意向・援助の基本方針・留意事項・緊急時対応・説明日/代理人同意 を追加
--   4) 初回作成日・計画作成者・作成区分 (初回/変更/更新) を追加
--   5) 取込元/根拠のリンク列 (居宅計画・カンファレンス・手順書) を追加
--
-- ❗ 旧列 long_term_goal / short_term_goal / services は DROP する。
--    実行前に本番 0 行であることを確認済 (2026-08-07 REST count=0)。
--    万一 row があれば下の 0) で backup が残る。
--
-- ❗ Supabase SQL Editor では BEGIN; 〜 COMMIT; を 1 ブロックで貼って Run。
--    COMMIT 忘れは auto-rollback (memory: feedback_supabase_sql_editor.md)

BEGIN;

-- 0) 念のため backup (0 行なら空テーブルができるだけ)
CREATE TABLE IF NOT EXISTS _backup_kaigo_houmon_care_plans_20260807 AS
SELECT * FROM kaigo_houmon_care_plans;

-- 1) 追加列 ------------------------------------------------------------------

ALTER TABLE kaigo_houmon_care_plans
  -- 作成区分 (ほのぼの: 新規/変更。運用では 更新 も使う)
  ADD COLUMN IF NOT EXISTS plan_kind TEXT NOT NULL DEFAULT '初回',
  -- 初回作成日 (= 変更/更新版でも初回の日付を残す)
  ADD COLUMN IF NOT EXISTS initial_plan_date DATE,
  -- 計画作成者 (author_name = サービス提供責任者 と別枠)
  ADD COLUMN IF NOT EXISTS creator_name TEXT,
  -- 本人の意向 / 家族の意向 / 援助の基本方針 (居宅 第1表から取込可能)
  ADD COLUMN IF NOT EXISTS user_intention TEXT,
  ADD COLUMN IF NOT EXISTS family_intention TEXT,
  ADD COLUMN IF NOT EXISTS basic_policy TEXT,
  -- ニーズ → 長期目標(期間) → 短期目標(期間)
  --   [{ needs, long_term_goal, long_term_period, short_term_goal, short_term_period }, ...]
  ADD COLUMN IF NOT EXISTS goals JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- 週間サービス計画
  --   [{ days: ["mon",...], start_time: "09:00", end_time: "09:45",
  --      service_kind: "身体2", content, notes }, ...]
  ADD COLUMN IF NOT EXISTS weekly_services JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- 留意事項 / 緊急時の対応
  ADD COLUMN IF NOT EXISTS precautions TEXT,
  ADD COLUMN IF NOT EXISTS emergency_response TEXT,
  -- 同意まわり (説明日 / 代理人)
  ADD COLUMN IF NOT EXISTS explained_on DATE,
  ADD COLUMN IF NOT EXISTS consent_proxy_name TEXT,
  ADD COLUMN IF NOT EXISTS consent_proxy_relation TEXT,
  -- 取込元・根拠へのリンク (いずれも任意)
  ADD COLUMN IF NOT EXISTS source_care_plan_doc_id UUID,   -- kaigo_report_documents (居宅 第1/2表)
  ADD COLUMN IF NOT EXISTS conference_id UUID,             -- kaigo_care_conferences
  ADD COLUMN IF NOT EXISTS procedure_document_id UUID;     -- kaigo_visit_procedure_documents

-- 2) 作成区分の CHECK (DROP → ADD の順)
ALTER TABLE kaigo_houmon_care_plans
  DROP CONSTRAINT IF EXISTS kaigo_houmon_care_plans_plan_kind_check;
UPDATE kaigo_houmon_care_plans
  SET plan_kind = '初回'
  WHERE plan_kind IS NULL OR plan_kind NOT IN ('初回', '変更', '更新');
ALTER TABLE kaigo_houmon_care_plans
  ADD CONSTRAINT kaigo_houmon_care_plans_plan_kind_check
  CHECK (plan_kind IN ('初回', '変更', '更新'));

-- 3) 旧列の内容を新構造へ移送してから DROP -----------------------------------
--    (0 行想定だが、row があっても取りこぼさないように移送してから落とす)
--
--    ❗ 移送 UPDATE は旧列を直接参照するため、2 回目の実行では
--       「column "long_term_goal" does not exist」で落ちる。
--       再適用が no-op になるよう、旧列が残っている場合だけ実行する。

DO $migrate_old_cols$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'kaigo_houmon_care_plans' AND column_name = 'long_term_goal'
  ) THEN
    EXECUTE $sql$
      UPDATE kaigo_houmon_care_plans
      SET goals = jsonb_build_array(
            jsonb_build_object(
              'needs', '',
              'long_term_goal', COALESCE(long_term_goal, ''),
              'long_term_period', '',
              'short_term_goal', COALESCE(short_term_goal, ''),
              'short_term_period', ''
            )
          )
      WHERE goals = '[]'::jsonb
        AND (COALESCE(long_term_goal, '') <> '' OR COALESCE(short_term_goal, '') <> '')
    $sql$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'kaigo_houmon_care_plans' AND column_name = 'services'
  ) THEN
    EXECUTE $sql$
      UPDATE kaigo_houmon_care_plans p
      SET weekly_services = COALESCE((
            SELECT jsonb_agg(
                     jsonb_build_object(
                       'days', '[]'::jsonb,
                       'start_time', '',
                       'end_time', '',
                       'service_kind', COALESCE(s->>'kind', ''),
                       -- 旧 frequency / time_range は自由文なので留意点に退避
                       'content', COALESCE(s->>'content', ''),
                       'notes', TRIM(BOTH ' ' FROM
                                  COALESCE(s->>'frequency', '') || ' ' || COALESCE(s->>'time_range', ''))
                     )
                   )
            FROM jsonb_array_elements(p.services) AS s
          ), '[]'::jsonb)
      WHERE p.weekly_services = '[]'::jsonb
        AND jsonb_typeof(p.services) = 'array'
        AND jsonb_array_length(p.services) > 0
    $sql$;
  END IF;
END
$migrate_old_cols$;

ALTER TABLE kaigo_houmon_care_plans
  DROP COLUMN IF EXISTS long_term_goal,
  DROP COLUMN IF EXISTS short_term_goal,
  DROP COLUMN IF EXISTS services;

-- 4) COMMENT -----------------------------------------------------------------

COMMENT ON COLUMN kaigo_houmon_care_plans.goals IS
  'ニーズ・目標 行配列: [{ needs, long_term_goal, long_term_period, short_term_goal, short_term_period }, ...] (居宅 第2表 needs_blocks から取込可)';
COMMENT ON COLUMN kaigo_houmon_care_plans.weekly_services IS
  '週間サービス計画: [{ days: ["mon"...], start_time, end_time, service_kind, content, notes }, ...]';
COMMENT ON COLUMN kaigo_houmon_care_plans.plan_kind IS '作成区分: 初回 / 変更 / 更新';
COMMENT ON COLUMN kaigo_houmon_care_plans.source_care_plan_doc_id IS
  '取込元の居宅サービス計画書 (kaigo_report_documents.id)';
COMMENT ON COLUMN kaigo_houmon_care_plans.conference_id IS
  '根拠となったサービス担当者会議/カンファレンス (kaigo_care_conferences.id)';
COMMENT ON COLUMN kaigo_houmon_care_plans.procedure_document_id IS
  'この計画書から作成した手順書 (kaigo_visit_procedure_documents.id)';

-- 5) index (利用者 × 計画日 の降順取得が主動線)
CREATE INDEX IF NOT EXISTS idx_kaigo_houmon_care_plans_user_date
  ON kaigo_houmon_care_plans(user_id, plan_date DESC);

COMMIT;
