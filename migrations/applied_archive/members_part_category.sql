-- ============================================================================
-- members にパート区分 (社保/通常/扶養) と扶養年収上限を追加
-- ============================================================================
-- 2026-07-29。パートの稼働管理を 3 区分に分ける:
--   社保 … 社保加入パート。稼働アップ・常勤化打診の対象
--   通常 … 社保未加入・扶養外。週 20h の社保加入ラインを監視
--   扶養 … 年収の壁が天井。年間累計の着地予測で超過を予防
--
-- employment_type の CHECK ('常勤','非常勤','パート') は変更しない。
-- パート給与計算 (load-part-time.ts) が employment_type='パート' 完全一致で
-- 対象判定しており、値を分割すると給与計算から静かに漏れるため、別列で持つ。
--
-- fuyou_annual_limit = 扶養パートの年収上限 (円/年)。NULL = アプリ既定 130 万。
-- 年収の壁は制度改定で動くので、人別に上書きできる列にしておく。
--
-- 既存の kaigo_payroll_staff_settings.social_insurance (通信手当判定) とは独立。
-- 不一致 (社保区分なのに未加入 等) は staff-payroll 画面が警告する。
--
-- Supabase SQL Editor に貼って Run。冪等。
-- ============================================================================

BEGIN;

ALTER TABLE members ADD COLUMN IF NOT EXISTS part_category TEXT
  CHECK (part_category IN ('社保', '通常', '扶養'));

ALTER TABLE members ADD COLUMN IF NOT EXISTS fuyou_annual_limit INTEGER;

COMMENT ON COLUMN members.part_category IS
  'パート区分 (employment_type=パート のみ意味を持つ)。社保/通常/扶養';
COMMENT ON COLUMN members.fuyou_annual_limit IS
  '扶養パートの年収上限 (円/年)。NULL=既定 1,300,000';

COMMIT;

-- 確認:
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'members' AND column_name IN ('part_category', 'fuyou_annual_limit');
--
-- ロールバック:
-- ALTER TABLE members DROP COLUMN IF EXISTS part_category;
-- ALTER TABLE members DROP COLUMN IF EXISTS fuyou_annual_limit;
