-- kaigo_assessments の旧世代ADL評価列19個を削除。
--
-- 2026-09-02 のphantom列監査(PERF_CLEANUP_MISSION.md参照)で発見。
-- 実データ113行(=全行)が100%NULL・kaigo-app/order-app/calendar-app/
-- payroll-app/property-appの4app全部を検索してもコード参照0件。
--
-- 2026-08-31に導入された実際の「生活アセスメント」機能(PDF取込、94〜165名分)は
-- overall_summary/family_situation/housing_situation等の別フィールドを使っており、
-- この19列は第一世代の設計が使われないまま第二世代に置き換わった残骸と見られる。
--
-- ⚠⚠ CLAUDE.md 4.1 に以下の記載がある(このSQLを実行するなら合わせて更新が必要):
--   | kaigo_assessments | bathing_status etc | 自立 / 見守り / 一部介助 / 全介助 |
--   → 実行後は CLAUDE.md からこの行を削除すること (CHECK制約も列と一緒に消える)。
--
-- ⚠ 対象は19列と規模が大きく、CLAUDE.mdに明記されている列でもあるため、
--   実行は必ずuserの明示判断を仰いでから。
--
-- Supabase SQL Editor で BEGIN〜COMMIT を1ブロックとして貼って実行してください。
-- (CLAUDE.md 7.2: BEGIN のみで COMMIT を忘れると SQL Editor 終了時に自動 rollback される)

BEGIN;

-- 削除前に全行backup (全て NULL のはずだが念のため丸ごと保存)
CREATE TABLE IF NOT EXISTS public._backup_kaigo_assessments_legacy_adl_20260902 AS
SELECT
  id, user_id, certification_id,
  bathing_status,
  cleaning_status,
  cognition_status, cognition_notes,
  communication_status,
  cooking_status,
  dressing_status, dressing_notes,
  eating_status, eating_notes,
  grooming_status, grooming_notes,
  laundry_status,
  mobility_status, mobility_notes,
  money_management_status,
  shopping_status,
  toileting_status, toileting_notes
FROM public.kaigo_assessments;

-- ⚠ CREATE TABLE AS は RLS を継承しない (feedback_backup_table_no_rls.md)。
--   利用者の身体状況に関する列なので作成直後に必ず遮断する。
ALTER TABLE public._backup_kaigo_assessments_legacy_adl_20260902 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public._backup_kaigo_assessments_legacy_adl_20260902 FORCE ROW LEVEL SECURITY;

ALTER TABLE public.kaigo_assessments
  DROP COLUMN bathing_status,
  DROP COLUMN cleaning_status,
  DROP COLUMN cognition_status,
  DROP COLUMN cognition_notes,
  DROP COLUMN communication_status,
  DROP COLUMN cooking_status,
  DROP COLUMN dressing_status,
  DROP COLUMN dressing_notes,
  DROP COLUMN eating_status,
  DROP COLUMN eating_notes,
  DROP COLUMN grooming_status,
  DROP COLUMN grooming_notes,
  DROP COLUMN laundry_status,
  DROP COLUMN mobility_status,
  DROP COLUMN mobility_notes,
  DROP COLUMN money_management_status,
  DROP COLUMN shopping_status,
  DROP COLUMN toileting_status,
  DROP COLUMN toileting_notes;

COMMIT;

-- 確認用 (Editorで別途流す。上のCOMMIT後に):
-- SELECT count(*) FROM public._backup_kaigo_assessments_legacy_adl_20260902;
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='kaigo_assessments' AND column_name LIKE '%_status' OR column_name LIKE '%_notes';
--   (bathing_status等の19列が消えていることを確認。bathing_notes/communication_notes/
--    overall_summary等の生活アセスメント側フィールド(refsあり)は対象外なので残る)
