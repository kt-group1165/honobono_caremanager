-- ============================================================================
-- kaigo_visit_addon_lines.system に '総合事業' を許可する
--
-- ── なぜ要るか ────────────────────────────────────────────────────────
--   総合事業にも**定額加算**がある (A24001 訪問型独自サービス初回加算 200単位/月)。
--   稼働データ (MEISAI) には現れないため、介護と同じく提供表の加算エディタ
--   (kaigo_visit_addon_lines) に持たせて集計する必要がある。
--   CHECK が ('介護','障害') のままだと INSERT が丸ごと失敗し、
--   同じバッチの介護分まで入らない (2026-08-07 K姉で 11 件全滅)。
--
--   この加算は **限度額管理対象**に入り、処遇改善の母数にも算入される
--   (実伝送 花見川 1004033104: 限度対象 287→487 / 処遇改善 76→130 = 487×266‰)。
-- ============================================================================
BEGIN;

ALTER TABLE kaigo_visit_addon_lines
  DROP CONSTRAINT IF EXISTS kaigo_visit_addon_lines_system_check;

ALTER TABLE kaigo_visit_addon_lines
  ADD CONSTRAINT kaigo_visit_addon_lines_system_check
  CHECK (system IS NULL OR system IN ('介護', '障害', '総合事業'));

COMMENT ON COLUMN kaigo_visit_addon_lines.system IS
  '制度区分。介護 / 障害 / 総合事業。総合事業にも定額加算がある (A24001 訪問型独自サービス初回加算 200単位/月) ため 2026-08-07 に追加';

COMMIT;
