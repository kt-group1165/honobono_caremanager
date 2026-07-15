-- ============================================================================
-- kaigo_visit_addon_lines に system 列 (介護/障害) を追加
-- ============================================================================
-- 2026-07-15。障害福祉の回/月単位加算 (居介初回 116020 / 緊急時対応 116025 /
-- 福祉専門職員等連携 116105 / 上限額管理 115010 / 喀痰吸引 116100、重訪側 125010,
-- 125037, 126020, 126025, 126026, 126100, 126720, 126725) を提供表の加算エディタ
-- (障害モード) から入力できるようにするため、行がどちらの制度のものかを持つ。
--
-- 背景: 同一 6 桁コードが介護/障害の両マスタに存在する (例 116192 = 介護:口腔連携
-- 強化加算 / 障害:家事日10.5・2人)。system 列なしで共有すると、障害の加算行が
-- 介護請求で誤解決される (逆も) ため、列で分離して集計側もフィルタする。
--
-- 適用: Supabase SQL Editor に全文貼って Run (BEGIN〜COMMIT 1ブロック)。
-- 適用前でもアプリは従来どおり動く (障害の加算エディタのみ無効表示)。
-- ============================================================================
BEGIN;

ALTER TABLE kaigo_visit_addon_lines
  ADD COLUMN IF NOT EXISTS system TEXT NOT NULL DEFAULT '介護'
    CHECK (system IN ('介護', '障害'));

COMMENT ON COLUMN kaigo_visit_addon_lines.system IS
  '加算コードの制度区分 (介護 / 障害)。既存行は介護。同一6桁コードが両制度に存在するため必須。';

-- UNIQUE を (client, month, office, addon_code) → (…, system) に付け替える。
-- 既存の unique 制約名は環境依存のため pg_constraint から特定して DROP する。
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'kaigo_visit_addon_lines'::regclass
     AND contype = 'u';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE kaigo_visit_addon_lines DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE kaigo_visit_addon_lines
  ADD CONSTRAINT uq_visit_addon_lines_client_month_office_code_system
  UNIQUE (client_id, target_month, office_id, addon_code, system);

COMMIT;

-- ── 検証 ────────────────────────────────────────────────────────────────────
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'kaigo_visit_addon_lines';         -- system が増えていること
-- SELECT conname FROM pg_constraint
--  WHERE conrelid = 'kaigo_visit_addon_lines'::regclass AND contype = 'u';
--   -- uq_visit_addon_lines_client_month_office_code_system 1 件のみ
