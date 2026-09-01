-- 空のバックアップ残骸テーブルを削除。
-- 2026-09-02 RLS横断チェックで発見: どちらも実データ0件、他コードからの参照なし。
-- DROP直前に再確認済み (service_role で count=exact、両方とも */0)。
--
-- Supabase SQL Editor で BEGIN〜COMMIT を1ブロックとして貼って実行してください。
-- (CLAUDE.md 7.2: BEGIN のみで COMMIT を忘れると SQL Editor 終了時に自動 rollback される)

BEGIN;

DROP TABLE IF EXISTS public._backup_equipment_prices_20260701;
DROP TABLE IF EXISTS public._backup_kaigo_houmon_care_plans_20260807;

COMMIT;
