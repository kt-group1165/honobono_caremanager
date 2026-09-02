-- READ ONLY診断: pg_stat_user_indexes の idx_scan=0 が「本当に未使用」なのか
-- 「まだ統計が溜まっていないだけ」なのかを判定するための、DB起動時刻/統計リセット時刻確認。
-- Supabase SQL Editor で実行してください。

SELECT pg_postmaster_start_time() AS db_start_time,
       now() - pg_postmaster_start_time() AS uptime;

-- 現在接続しているDBの統計リセット時刻 (stats_reset は datid 一致で1行のはず)
SELECT datname, stats_reset
FROM pg_stat_database
WHERE datname = current_database();
