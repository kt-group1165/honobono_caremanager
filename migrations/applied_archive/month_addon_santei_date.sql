-- ============================================================================
-- 訪問介護 月次加算 (初回 / 生活機能向上連携 等) に「算定日」を持たせる
-- ============================================================================
-- 2026-07-11。月次加算は月単位算定のため算定「日」を持っておらず、
--   1. 保険者変更 (転居) 月のレセプト分割 → 月末側セグメントに計上 + warning
--   2. 生保等の月途中開始の公費期間按分 → 全量公費対象 + warning
-- の 2 箇所が暫定ルールだった。算定日 (NULL = 未指定) を任意入力できるようにし、
-- visit-seikyu/aggregate.ts がセグメント期間 / 公費適用期間の判定に使う。
-- NULL のままなら従来動作 (月末側計上 + warning / 全量公費 + warning) にフォールバック。
--
-- 対象テーブル:
--   kaigo_visit_addon_lines  : 現行の月次加算エディタ (提供表 provision-tickets) の書込先。
--                              1 行 = 1 加算コードなので santei_date 1 列。
--   kaigo_visit_month_addons : 旧 3固定フラグ (初回/緊急時/生活機能向上)。書込 UI は撤去済みだが
--                              aggregate が読み続けている (移行期データ用) ため、
--                              初回・生活機能向上それぞれの算定日列を追加する。
--                              緊急時は kinkyu_houmon (シフト実績の訪問日) で判定済みのため日不要。
--
-- 適用: Supabase SQL Editor に本ブロックをそのまま貼って Run (BEGIN〜COMMIT 1 ブロック)。
-- 冪等 (IF EXISTS / IF NOT EXISTS)。未適用でもアプリは従来動作で動く (列 42703 フォールバック)。
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'kaigo_visit_addon_lines') THEN
    ALTER TABLE kaigo_visit_addon_lines
      ADD COLUMN IF NOT EXISTS santei_date DATE;
    COMMENT ON COLUMN kaigo_visit_addon_lines.santei_date IS
      '算定日 (任意)。レセプト分割 (保険者変更月) のセグメント判定・公費期間按分に使う。NULL = 未指定 (従来動作: 月末側計上 + warning)';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'kaigo_visit_month_addons') THEN
    ALTER TABLE kaigo_visit_month_addons
      ADD COLUMN IF NOT EXISTS shokai_santei_date DATE,
      ADD COLUMN IF NOT EXISTS seikatsu_santei_date DATE;
    COMMENT ON COLUMN kaigo_visit_month_addons.shokai_santei_date IS
      '初回加算の算定日 (任意 = 初回訪問日)。NULL = 未指定 (従来動作)';
    COMMENT ON COLUMN kaigo_visit_month_addons.seikatsu_santei_date IS
      '生活機能向上連携加算の算定日 (任意)。NULL = 未指定 (従来動作)';
  END IF;
END $$;

COMMIT;
