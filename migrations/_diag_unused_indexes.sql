-- READ ONLY診断: 未参照(スキャン0回)のindexを一覧化する。
-- Claude Code のツールからは pg_catalog / pg_stat_* に直接アクセスできないため、
-- Supabase SQL Editor で実行して結果を貼り戻してもらう想定。
-- ⚠ idx_scan はDBが起動してからの累積値。直近でリスタートしていると
--   実際は使われているindexも0回に見えることがあるので、結果は鵜呑みにせず
--   「候補」として扱うこと(→ _diag_stats_reset_check.sql で起動時刻を確認)。
--
-- 2026-09-02 是正: primary key / unique制約 の除外を index名のパターン一致
-- (%_pkey / %_key) でやっていたが、このDBは `_uniq` / `_uk` / `uniq_` / `uq_` など
-- 命名が統一されておらず、名前ベースの除外だと `staff_invitations_login_id_active_uniq`
-- 等の重複防止indexを取りこぼして削除候補に混入させてしまっていた。
-- pg_index.indisprimary / indisunique の実フラグで判定するよう修正。

SELECT
  n.nspname AS schemaname,
  t.relname AS table_name,
  i.relname AS index_name,
  s.idx_scan AS scan_count,
  pg_size_pretty(pg_relation_size(s.indexrelid)) AS index_size,
  ix.indisunique AS is_unique_constraint
FROM pg_stat_user_indexes s
JOIN pg_index ix ON ix.indexrelid = s.indexrelid
JOIN pg_class i ON i.oid = s.indexrelid
JOIN pg_class t ON t.oid = s.relid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE s.schemaname = 'public'
  AND s.idx_scan = 0
  AND ix.indisprimary = false   -- primary key は除外 (構造フラグで判定)
  AND ix.indisunique = false    -- unique制約由来も除外 (構造フラグで判定。命名規則に依存しない)
ORDER BY pg_relation_size(s.indexrelid) DESC;
