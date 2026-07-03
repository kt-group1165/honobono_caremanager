-- ============================================================================
-- 利用実費 (保険外費用) の請求 (2026-07-03)
-- ============================================================================
-- ほのぼの 訪問介護請求管理編 1-3「利用者の利用実費分の計算・入力」対応。
-- 交通費・キャンセル料等の保険外実費を利用者×月で入力し、
-- 利用請求の請求書に行として合算する。

BEGIN;

CREATE TABLE IF NOT EXISTS riyou_jippi_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL DEFAULT 'kt-group',
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  target_month  TEXT NOT NULL,              -- 'YYYY-MM'
  item_name     TEXT NOT NULL,              -- 項目名 (交通費 / キャンセル料 等)
  unit_price    INT NOT NULL DEFAULT 0,     -- 単価 (円)
  quantity      INT NOT NULL DEFAULT 1,     -- 数量
  amount        INT NOT NULL DEFAULT 0,     -- 金額 (円) = 単価×数量 or 手入力
  provide_date  DATE,                       -- 提供日 (任意)
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_riyou_jippi_client_month
  ON riyou_jippi_entries (client_id, target_month);
CREATE INDEX IF NOT EXISTS idx_riyou_jippi_month
  ON riyou_jippi_entries (target_month);

ALTER TABLE riyou_jippi_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS riyou_jippi_entries_all ON riyou_jippi_entries;
CREATE POLICY riyou_jippi_entries_all ON riyou_jippi_entries
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
