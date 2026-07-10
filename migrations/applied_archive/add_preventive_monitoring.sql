-- ============================================================================
-- 介護予防支援モニタリング（予防版）対応
--   kaigo_monitoring_sheets に予防様式を非破壊で追加するための列を足す。
--
--   背景:
--     要介護のモニタリング（毎月・居宅サービス計画実施状況報告書）は
--     既存の kaigo_monitoring_items（6行の短期目標×達成度）で表現する。
--     介護予防支援（要支援1/2・事業対象者）のモニタリングは頻度が
--     「少なくとも3月に1回、及びサービス評価期間終了月」で様式も
--     「目標達成状況の評価／サービス継続の要否」中心の経過記録型。
--
--   方針:
--     - kaigo_monitoring_items（要介護様式）は一切いじらない。
--     - kaigo_monitoring_sheets に form_type を足し、'要介護'/'予防' で分岐。
--     - 予防様式のフォーム値は preventive_content(jsonb) に丸ごと入れる
--       （項目が要介護と全く異なるため、列を増やさず jsonb で保持する）。
--
--   ※ Supabase SQL Editor に貼る場合は BEGIN;〜COMMIT; を1ブロックで Run。
-- ============================================================================
BEGIN;

-- 1. 様式種別（既存行はすべて要介護様式とみなす）
ALTER TABLE kaigo_monitoring_sheets
  ADD COLUMN IF NOT EXISTS form_type TEXT NOT NULL DEFAULT '要介護';

-- CHECK 制約（DROP→ADD の順で冪等化）
ALTER TABLE kaigo_monitoring_sheets
  DROP CONSTRAINT IF EXISTS kaigo_monitoring_sheets_form_type_check;
ALTER TABLE kaigo_monitoring_sheets
  ADD CONSTRAINT kaigo_monitoring_sheets_form_type_check
  CHECK (form_type IN ('要介護', '予防'));

-- 2. 予防様式の入力値（jsonb）。要介護様式では NULL のまま。
--    構造（アプリ側 PreventiveContent 型と一致）:
--    {
--      "office_name": string,
--      "evaluation_period_start": "YYYY-MM-DD",
--      "evaluation_period_end": "YYYY-MM-DD",
--      "monitoring_type": "通常" | "サービス評価期間終了" | "状態変化時",
--      "next_monitoring_date": "YYYY-MM-DD",
--      "overall_evaluation": string,          -- 総合的な評価・支援経過
--      "user_family_intention": string,       -- 本人・家族の意向
--      "continuation_decision": "継続" | "変更" | "終了" | "",
--      "continuation_reason": string,
--      "goals": [                             -- 目標ごとの達成状況評価
--        {
--          "goal": string,                    -- 目標（本人等のセルフケアや支援内容）
--          "period": string,                  -- 期間
--          "service": string,                 -- 本人・家族・地域の取組／サービス
--          "achievement": "達成" | "一部達成" | "未達成" | "",
--          "evaluation": string               -- 評価・今後の方針
--        }
--      ]
--    }
ALTER TABLE kaigo_monitoring_sheets
  ADD COLUMN IF NOT EXISTS preventive_content JSONB;

COMMIT;

-- ============================================================================
-- ロールバック（必要な場合のみ）:
--   ALTER TABLE kaigo_monitoring_sheets DROP COLUMN IF EXISTS preventive_content;
--   ALTER TABLE kaigo_monitoring_sheets DROP CONSTRAINT IF EXISTS kaigo_monitoring_sheets_form_type_check;
--   ALTER TABLE kaigo_monitoring_sheets DROP COLUMN IF EXISTS form_type;
-- ============================================================================
