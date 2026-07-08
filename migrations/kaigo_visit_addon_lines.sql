-- ============================================================================
-- 訪問介護 サービス加算の可変明細 (マスタ駆動)。利用者 × 月 × 事業所 × 加算コード
-- ============================================================================
-- 2026-07-08。従来の kaigo_visit_month_addons (初回/緊急時/生活機能向上の3固定列) を
-- やめ、その事業所のサービス種別で使える加算を kaigo_service_codes から一覧選択できる
-- 汎用テーブルにする (ほのぼの「加算サービス項目」相当)。
--   addon_code : kaigo_service_codes.service_code (114001=初回, 114000=緊急時, CB_A2… 等)
--   count      : 回数 (初回=1, 緊急時=回数, 生活機能向上=1)
-- 単位数はここに持たない (マスタを validInMonth で解決 = 世代・改定に自動追従)。
-- 集計 (aggregate) は lib/visit-addons.ts の resolveVisitAddonLines で読む。
--
-- 適用: Supabase SQL Editor に全文貼って Run (BEGIN〜COMMIT 1ブロック)。
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS kaigo_visit_addon_lines (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT NOT NULL DEFAULT 'kt-group',
  office_id    UUID NOT NULL,
  client_id    UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  target_month TEXT NOT NULL,                 -- 'YYYY-MM' (サービス提供月)
  addon_code   TEXT NOT NULL,                 -- kaigo_service_codes.service_code
  count        INT  NOT NULL DEFAULT 1 CHECK (count >= 0),
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, target_month, office_id, addon_code)
);

CREATE INDEX IF NOT EXISTS idx_visit_addon_lines_office_month
  ON kaigo_visit_addon_lines (office_id, target_month);

ALTER TABLE kaigo_visit_addon_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kaigo_visit_addon_lines_all ON kaigo_visit_addon_lines;
CREATE POLICY kaigo_visit_addon_lines_all ON kaigo_visit_addon_lines
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── 旧 kaigo_visit_month_addons (3固定) からの移行 ──────────────────────────
-- テーブルが存在する場合のみ、初回/緊急時/生活機能向上 を加算コード行に変換。
-- 加算コード: 初回=114001 / 緊急時=114000 / 生活機能向上Ⅰ=114003 / Ⅱ=114002。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'kaigo_visit_month_addons') THEN
    -- 初回加算
    INSERT INTO kaigo_visit_addon_lines (tenant_id, office_id, client_id, target_month, addon_code, count, notes)
    SELECT tenant_id, office_id, client_id, target_month, '114001', 1, '[migrated from month_addons]'
    FROM kaigo_visit_month_addons WHERE shokai = true AND office_id IS NOT NULL
    ON CONFLICT (client_id, target_month, office_id, addon_code) DO NOTHING;
    -- 緊急時 (回数)
    INSERT INTO kaigo_visit_addon_lines (tenant_id, office_id, client_id, target_month, addon_code, count, notes)
    SELECT tenant_id, office_id, client_id, target_month, '114000', kinkyu_count, '[migrated from month_addons]'
    FROM kaigo_visit_month_addons WHERE COALESCE(kinkyu_count,0) > 0 AND office_id IS NOT NULL
    ON CONFLICT (client_id, target_month, office_id, addon_code) DO NOTHING;
    -- 生活機能向上連携 Ⅰ/Ⅱ
    INSERT INTO kaigo_visit_addon_lines (tenant_id, office_id, client_id, target_month, addon_code, count, notes)
    SELECT tenant_id, office_id, client_id, target_month,
           CASE seikatsu_kino WHEN 'Ⅰ' THEN '114003' WHEN 'Ⅱ' THEN '114002' END, 1, '[migrated from month_addons]'
    FROM kaigo_visit_month_addons WHERE seikatsu_kino IN ('Ⅰ','Ⅱ') AND office_id IS NOT NULL
    ON CONFLICT (client_id, target_month, office_id, addon_code) DO NOTHING;
  END IF;
END $$;

COMMIT;
