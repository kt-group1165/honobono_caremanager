-- ============================================================================
-- kaigo_monitoring_sheets / kaigo_monitoring_items に、ほのぼの「モニタリング
-- 記録表」の実項目に合わせた列を追加する (2026-09-14)
--
-- ── なぜ要るか ────────────────────────────────────────────────────────────
--   当方の既存列 (user_satisfaction/achievement/adl_change 等) は汎用様式で
--   設計されており、ほのぼのの実際の帳票 (課題/サービス内容/満足度/ニーズ充足度/
--   対応/確認方法/確認期日/総括/再アセスメントの必要) と項目の意味が合わない。
--   両テーブルとも運用実績が0行 (2026-09-14時点) のため、★既存列は一切変更せず
--   (非破壊)、ほのぼの様式に合わせた列を追加する方針にした (H/user判断)。
--
-- ── 取込方針 (SQL適用後、import_monitoring_from_pdf.mjs から書く列) ────────
--   既存のCHECK付き列 (user_satisfaction/family_satisfaction/achievement/
--   adl_change/plan_revision_needed) には★取込では入れない (null のまま)。
--   ★user_satisfaction/family_satisfactionのCHECKは変えない (画面の選択肢と
--   対応しているため)。新設列にPDFの原文をそのまま入れる。
--
-- ⚠ Supabase SQL Editor に貼る場合は BEGIN;〜COMMIT; を1ブロックでRun。
-- ============================================================================
BEGIN;

-- kaigo_monitoring_items: 行(課題)レベルの新規項目
ALTER TABLE kaigo_monitoring_items
  ADD COLUMN IF NOT EXISTS issue TEXT,                      -- 生活全般の解決すべき課題
  ADD COLUMN IF NOT EXISTS service_content TEXT,            -- サービス内容 (①②を分割しない原文)
  ADD COLUMN IF NOT EXISTS user_comment TEXT,                -- 利用者本人の意見・要望 (自由文)。
                                                              --   satisfaction_comment(既存・user/family共有)は使わず対にする
  ADD COLUMN IF NOT EXISTS family_comment TEXT,              -- 家族の意見・要望 (自由文)
  ADD COLUMN IF NOT EXISTS user_evaluation TEXT,             -- 満足度(本人)。CHECK無し。原文のまま
                                                              --   ("満足している"/"ある程度満足している"/"その他" 等)
  ADD COLUMN IF NOT EXISTS family_evaluation TEXT,           -- 満足度(家族)。同上
  ADD COLUMN IF NOT EXISTS needs_fulfillment TEXT,           -- ニーズ充足度 ("ニーズ充足"/"変化なし" 等)
  ADD COLUMN IF NOT EXISTS execution_status TEXT,            -- サービスの実行確認 ("計画通り実行"/"実行していない" 等)
  ADD COLUMN IF NOT EXISTS confirm_method TEXT,              -- 確認方法 ("利用者・家族"/"提供機関"/"家族" 等)
  ADD COLUMN IF NOT EXISTS confirm_date DATE,                -- 確認期日
  ADD COLUMN IF NOT EXISTS next_action TEXT;                 -- 対応 ("ケア継続"/"継続"/"その他" 等)。
                                                              --   ⚠ plan_revision_needed(既存列)とは別物

-- kaigo_monitoring_sheets: シートレベルの新規項目
ALTER TABLE kaigo_monitoring_sheets
  ADD COLUMN IF NOT EXISTS summary TEXT,                     -- 総括
  ADD COLUMN IF NOT EXISTS plan_change TEXT,                 -- 計画の変更等
  ADD COLUMN IF NOT EXISTS reassessment_needed BOOLEAN,      -- 再アセスメントの必要 (あり/なし)。
                                                              --   ⚠ null可。「あり」の実例で選択判定ロジックを
                                                              --   確認できるまでは取込では常にnullにする運用
  ADD COLUMN IF NOT EXISTS reassessment_planned_date DATE;   -- 再アセスメントの実施予定日

COMMIT;

-- ── ロールバック (実行しない。参考として残す) ────────────────────────────
-- BEGIN;
-- ALTER TABLE kaigo_monitoring_items
--   DROP COLUMN IF EXISTS issue, DROP COLUMN IF EXISTS service_content,
--   DROP COLUMN IF EXISTS user_comment, DROP COLUMN IF EXISTS family_comment,
--   DROP COLUMN IF EXISTS user_evaluation, DROP COLUMN IF EXISTS family_evaluation,
--   DROP COLUMN IF EXISTS needs_fulfillment, DROP COLUMN IF EXISTS execution_status,
--   DROP COLUMN IF EXISTS confirm_method, DROP COLUMN IF EXISTS confirm_date,
--   DROP COLUMN IF EXISTS next_action;
-- ALTER TABLE kaigo_monitoring_sheets
--   DROP COLUMN IF EXISTS summary, DROP COLUMN IF EXISTS plan_change,
--   DROP COLUMN IF EXISTS reassessment_needed, DROP COLUMN IF EXISTS reassessment_planned_date;
-- COMMIT;
