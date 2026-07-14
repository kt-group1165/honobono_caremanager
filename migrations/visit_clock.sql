-- ============================================================================
-- kaigo_visit_schedule: 訪問打刻列 (clock_in_at / clock_out_at) 追加
-- ============================================================================
-- スマホ用サービス記録 (/m/visit-records) の「開始/終了打刻」用。
-- 予定の start_time / end_time (予定時刻) は変更せず、押下時点の実時刻を
-- 別列で記録する (= 予実対比・直行直帰の勤怠エビデンス・特定事業所加算の記録)。
--
-- - 冪等 (ADD COLUMN IF NOT EXISTS)・additive のみ。既存行/既存列は不変更。
-- - 請求集計 (aggregate)・シフト管理の既存ロジックはこの列を参照しない (表示参照のみ)。
-- - 未適用環境ではアプリ側が列エラー (42703) を検知して打刻ボタンを自動非表示にする。
--
-- 適用: Supabase SQL Editor に BEGIN〜COMMIT を 1 ブロックで貼って Run。

BEGIN;

ALTER TABLE kaigo_visit_schedule
  ADD COLUMN IF NOT EXISTS clock_in_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS clock_out_at TIMESTAMPTZ;

COMMENT ON COLUMN kaigo_visit_schedule.clock_in_at IS
  'サービス開始打刻 (スマホ /m/visit-records の押下時刻)。予定 start_time とは別管理 (予実対比用)';
COMMENT ON COLUMN kaigo_visit_schedule.clock_out_at IS
  'サービス終了打刻 (スマホ /m/visit-records の押下時刻)。予定 end_time とは別管理 (予実対比用)';

COMMIT;
