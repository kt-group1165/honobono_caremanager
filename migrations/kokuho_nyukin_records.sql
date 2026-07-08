-- ============================================================================
-- 国保連 入金管理 (居宅介護支援の介護給付費請求 → 支払決定通知 → 入金 の照合)
-- ============================================================================
-- 2026-07-08。請求月 (target_month) × 事業所ごとに 1 行。
-- seikyu_amount = 請求時点の保険請求額スナップショット (kaigo_care_support_claims の
--   confirmed/submitted 合計 insurance_amount を作成時にコピー)。
-- kettei_amount = 国保連の支払決定通知の決定額。nyukin_date = 実際の入金日。
-- status: 未入金 / 入金済 / 差額あり (請求額 ≠ 決定額のとき)。
-- UI: billing/seikyu の入金管理タブ (_nyukin-content.tsx)。
-- Supabase SQL Editor に貼って Run (COMMIT まで 1 ブロックで)。

BEGIN;

CREATE TABLE IF NOT EXISTS kokuho_nyukin_records (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL DEFAULT 'kt-group',
  office_id      UUID NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  target_month   TEXT NOT NULL,             -- 請求月 'YYYY-MM'
  seikyu_amount  INT NOT NULL DEFAULT 0,    -- 請求額スナップショット (円)
  kettei_amount  INT,                       -- 支払決定額 (国保連の支払決定通知。NULL = 未通知)
  nyukin_date    DATE,                      -- 入金日
  status         TEXT NOT NULL DEFAULT '未入金'
                 CHECK (status IN ('未入金', '入金済', '差額あり')),
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (office_id, target_month)
);

CREATE INDEX IF NOT EXISTS idx_kokuho_nyukin_records_month
  ON kokuho_nyukin_records (target_month);

ALTER TABLE kokuho_nyukin_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kokuho_nyukin_records_all ON kokuho_nyukin_records;
CREATE POLICY kokuho_nyukin_records_all ON kokuho_nyukin_records
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
