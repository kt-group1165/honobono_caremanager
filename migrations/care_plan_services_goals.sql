-- ============================================================================
-- 居宅サービス計画書 第2表に **課題 → 長期目標 → 短期目標 → サービス** の
-- 対応関係を持たせる
--
-- ── いま何が落ちているか ────────────────────────────────────────────────
--   第2表は本来こういう入れ子:
--
--     解決すべき課題 (ニーズ)
--       └ 長期目標 (期間)
--           └ 短期目標 (期間)
--               └ サービス内容 / 種別 / 事業者 / 頻度 / 期間
--
--   ところが kaigo_care_plan_services は **サービス行だけ**を平らに持っていて、
--   課題は notes に「課題: …」と文字で入っているだけ。長期・短期目標は
--   kaigo_care_plans 側に **全部つなげた 1 本のテキスト**として入っている。
--   どの目標がどのサービスに対応するのかが判らない。
--
--   ほのぼのの ケアプラン/全/KAIGO1_H31.CSV には 1 行ごとに
--   課題・長期目標・短期目標・それぞれの期間が入っているので、持たせられる。
--
--   帳票 (reports/[type] care-plan-2) は今 blocks を 1 個しか作れておらず、
--   実際の計画書の形になっていない。列が入れば正しく組める。
--
-- 実行: Supabase SQL Editor に貼って Run
-- ============================================================================
BEGIN;

ALTER TABLE kaigo_care_plan_services
  ADD COLUMN IF NOT EXISTS needs               text,   -- 解決すべき課題 (ニーズ)
  ADD COLUMN IF NOT EXISTS long_term_goal      text,
  ADD COLUMN IF NOT EXISTS long_term_start     date,
  ADD COLUMN IF NOT EXISTS long_term_end       date,
  ADD COLUMN IF NOT EXISTS short_term_goal     text,
  ADD COLUMN IF NOT EXISTS short_term_start    date,
  ADD COLUMN IF NOT EXISTS short_term_end      date,
  ADD COLUMN IF NOT EXISTS service_start       date,
  ADD COLUMN IF NOT EXISTS service_end         date,
  ADD COLUMN IF NOT EXISTS display_order       integer;

COMMENT ON COLUMN kaigo_care_plan_services.needs IS
  '解決すべき課題 (ニーズ)。同じ課題の行をまとめると第2表の 1 ブロックになる';
COMMENT ON COLUMN kaigo_care_plan_services.display_order IS
  'ほのぼのの「表示順」。第2表の行の並び';

CREATE INDEX IF NOT EXISTS idx_care_plan_services_plan_order
  ON kaigo_care_plan_services (care_plan_id, display_order);

COMMIT;
