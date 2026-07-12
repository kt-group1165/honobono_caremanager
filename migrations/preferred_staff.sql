-- ============================================================================
-- client_office_assignments: 利用者×事業所ごとの「優先ヘルパー」リスト (jsonb)
-- ============================================================================
-- シフト管理の「ヘルパー割当サジェスト」(ほのぼの自動割当の第一歩、候補提示のみ) 用。
-- 利用者ごとに優先して割り当てたい職員 (members.id) を優先順で保持する。
--
-- 置き場所: client_office_assignments (利用者×事業所 junction)
--   - シフト管理は自事業所 (?office=) スコープで動くため、優先ヘルパーも
--     「この利用者 × この事業所」の属性として持つのが自然
--     (same_building_tier と同じパターン)。
--   - 読み書きは (client_id, office_id, end_date IS NULL) の行に対して行う。
--
-- 形式: '["<member uuid>", "<member uuid>", ...]' (優先順、先頭 = 1位、最大10件をアプリ側で制限)
--
-- フォールバック: アプリは列未適用 (42703/PGRST204) を検知して
--   サジェストの優先加点を無効化・設定 UI を保存不可表示にする (silent failure なし)。
--
-- ※ このファイルは冪等 (IF NOT EXISTS)。Supabase SQL Editor に全体を貼って Run
--   (BEGIN〜COMMIT を 1 ブロックで。COMMIT 忘れは auto rollback される点に注意)。
--   適用後は migrations/applied_archive/ へ移動する。

BEGIN;

ALTER TABLE client_office_assignments
  ADD COLUMN IF NOT EXISTS preferred_staff JSONB;

COMMENT ON COLUMN client_office_assignments.preferred_staff IS
  '優先ヘルパー (members.id の配列、優先順)。シフト管理の割当サジェスト用。NULL = 未設定';

COMMIT;
