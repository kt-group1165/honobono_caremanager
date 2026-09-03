-- ============================================================================
-- _backup_* テーブル 2 つが anon から読める状態だったのを塞ぐ
--
--   発見: 2026-09-03 / npm run check:anon の穴を追って実測 (READ ONLY)
--   原因: CREATE TABLE AS で作った表は **RLS を継承しない** ため、
--         RLS を明示的に有効化していない backup 表は anon に素通しになる
--         (memory: feedback_backup_table_no_rls)
--
-- ■ 実測 (anon key で SELECT。書込は試していない)
--     _backup_kaigo_care_plans_cm_20260902        40 行 読める
--       └ 36/40 行に 長期/短期目標の自由文 (療養に関する記述) が入っている
--       └ user_id は実在の利用者を指すが、clients 自体は anon 遮断済みなので
--         API 経由で氏名には辿り着けない
--     _backup_offices_hanamutsumi_tenantid_20260902  3 行 読める
--       └ 値が入っているのは name のみ ("千葉(上り)" 等の地域区分)
--       └ ai_api_key は 3 行とも null (鍵の露出は無い)
--
-- ■ 他の _backup_* は遮断済み (対照として確認)
--     _backup_clients_phone_20260602     659 行 … 遮断
--     _backup_clients_dedup_20260602   1,516 行 … 遮断
--     _backup_trusted_devices_20260831    31 行 … 遮断
--   → 全部が漏れているのではなく、この 2 つだけ RLS を付け忘れている
--
-- ■ 方針
--   policy は作らない。**RLS 有効 + policy 無し = 完全遮断**にする
--   (他の _backup_* と同じ状態に揃える。service_role は RLS を迂回するので
--    復旧用途には引き続き使える)
--
-- ⚠ CLAUDE.md §7.2: BEGIN; だけで COMMIT; を忘れると実行終了で rollback される
-- ============================================================================

BEGIN;

ALTER TABLE public._backup_kaigo_care_plans_cm_20260902        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public._backup_offices_hanamutsumi_tenantid_20260902 ENABLE ROW LEVEL SECURITY;

COMMIT;

-- ============================================================================
-- 確認 (適用後に実行する。0 行になれば遮断できている)
--   ⚠ SQL Editor は service_role 相当で RLS を迂回するため、ここでは確認できない。
--     `npm run check:anon` か、anon key での REST 取得で確かめること。
-- ============================================================================

-- ■ 後日の判断: この 2 表はもう要らないなら DROP する (CLAUDE.md §7.3)
--   まだ復旧に使う可能性があるなら、上の RLS 有効化だけで安全になる。
--
-- DROP TABLE public._backup_kaigo_care_plans_cm_20260902;
-- DROP TABLE public._backup_offices_hanamutsumi_tenantid_20260902;
