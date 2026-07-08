-- ============================================================================
-- 訪問介護 実績単位の加算 (初回 / 緊急時 / 生活機能向上連携) — 利用者 × 月 × 事業所
-- ============================================================================
-- 2026-07-08。介護請求タブ (billing-visit/kaigo-seikyu) の明細ペインで
-- 利用者ごとに月次加算フラグを設定し、請求集計 (visit-seikyu/aggregate.ts) が
-- kaigo_service_codes から対象月の有効世代の単位数を引いて明細行に追加する。
--   shokai        : 初回加算 (114001, 200単位 × 1回)
--   seikatsu_kino : 生活機能向上連携加算 なし/Ⅰ(114003, 100単位)/Ⅱ(114002, 200単位)
--   kinkyu_count  : 緊急時訪問介護加算 (114000, 100単位) の当月回数
-- 単位数はここに持たない (マスタの世代管理 validInMonth に従う)。
-- 適用: Supabase SQL Editor に本ブロックをそのまま貼って Run (COMMIT まで 1 ブロック)。

BEGIN;

CREATE TABLE IF NOT EXISTS kaigo_visit_month_addons (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL DEFAULT 'kt-group',
  office_id     UUID NOT NULL,
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  target_month  TEXT NOT NULL,                     -- 'YYYY-MM' (サービス提供月)
  shokai        BOOLEAN NOT NULL DEFAULT false,    -- 初回加算
  seikatsu_kino TEXT NOT NULL DEFAULT 'なし'
                CHECK (seikatsu_kino IN ('なし', 'Ⅰ', 'Ⅱ')),  -- 生活機能向上連携加算
  kinkyu_count  INT NOT NULL DEFAULT 0
                CHECK (kinkyu_count >= 0),         -- 緊急時訪問介護加算の当月回数
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, target_month, office_id)
);

CREATE INDEX IF NOT EXISTS idx_visit_month_addons_office_month
  ON kaigo_visit_month_addons (office_id, target_month);

ALTER TABLE kaigo_visit_month_addons ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kaigo_visit_month_addons_all ON kaigo_visit_month_addons;
CREATE POLICY kaigo_visit_month_addons_all ON kaigo_visit_month_addons
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
