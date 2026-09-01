-- READ ONLY診断: 未参照(スキャン0回)のindexを一覧化する。
-- Claude Code のツールからは pg_catalog / pg_stat_* に直接アクセスできないため、
-- Supabase SQL Editor で実行して結果を貼り戻してもらう想定。
-- ⚠ idx_scan はDBが起動してからの累積値。直近でリスタートしていると
--   実際は使われているindexも0回に見えることがあるので、結果は鵜呑みにせず
--   「候補」として扱うこと。

SELECT
  schemaname,
  relname AS table_name,
  indexrelname AS index_name,
  idx_scan AS scan_count,
  pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
  AND idx_scan = 0
  AND indexrelname NOT LIKE '%_pkey'      -- primary key は除外 (制約として必要)
  AND indexrelname NOT LIKE '%_key'       -- unique制約由来も除外
ORDER BY pg_relation_size(indexrelid) DESC;
