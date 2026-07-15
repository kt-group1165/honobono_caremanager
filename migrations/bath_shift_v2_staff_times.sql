-- bath_shift_v2_staff_times : 訪問入浴×訪問介護 兼務対応 (職員ごとの乗車時間帯)
-- Phase: 訪問入浴シフト v2 (user 確定 2026-07-15)
--
-- 背景: 職員が同一日内で「この時間は号車 (訪問入浴)、この時間は訪問介護」と
--       兼務するケースがある。当日編成 (kaigo_bath_team_days) は日単位だったため、
--       職員ごとの乗車時間帯を持てるようにする。
--
-- staff_times: { "<members.id>": { "start": "09:00", "end": "12:00" } }
--   キーが無い職員 = 終日乗車。実績反映時は「コマ時刻をカバーする職員」だけを
--   従事職員にし、看護職員が居ない時間帯のコマは staff_only (減算) を自動判定。
--
-- Supabase SQL Editor に貼って実行 (BEGIN/COMMIT 入り)。

BEGIN;

ALTER TABLE kaigo_bath_team_days
  ADD COLUMN IF NOT EXISTS staff_times JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
