-- ============================================================================
-- 障害請求の状態管理 + 利用者負担の入金管理 (2026-07-08)
-- ============================================================================
-- ほのぼのMORE の「明細書発行済 → 請求対象化」「利用料請求書発行 → 入金処理」に対応。
-- 介護側の kaigo_billing_status / riyou_seikyu_payments と同じパターン。

BEGIN;

-- 1) 障害請求の状態 (利用者 × 月): 明細書発行済 / 伝送対象化
CREATE TABLE IF NOT EXISTS shogai_billing_status (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL DEFAULT 'kt-group',
  office_id     UUID,
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  target_month  TEXT NOT NULL,                   -- 'YYYY-MM' (サービス提供月)
  issued_at     TIMESTAMPTZ,                     -- 明細書発行日時 (NULL=未発行)
  densou_target BOOLEAN NOT NULL DEFAULT false,  -- 伝送対象化済み (電子請求受付システムへ)
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, target_month)
);

CREATE INDEX IF NOT EXISTS idx_shogai_billing_status_month
  ON shogai_billing_status (target_month, densou_target);

ALTER TABLE shogai_billing_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shogai_billing_status_all ON shogai_billing_status;
CREATE POLICY shogai_billing_status_all ON shogai_billing_status
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 2) 障害 利用者負担の請求・入金状況 (利用者 × 月)
CREATE TABLE IF NOT EXISTS shogai_seikyu_payments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL DEFAULT 'kt-group',
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  target_month   TEXT NOT NULL,               -- 'YYYY-MM' (サービス提供月)
  billed_amount  INT NOT NULL DEFAULT 0,      -- 請求額 (発行時点の利用者負担額)
  paid_amount    INT NOT NULL DEFAULT 0,      -- 入金額 (累計)
  paid_date      DATE,                        -- 最終入金日
  payment_method TEXT,                        -- 現金 / 振込 / 口座振替
  status         TEXT NOT NULL DEFAULT '請求済'
    CHECK (status IN ('請求済', '入金完', '一部入金', '未収')),
  issued_date    DATE,                        -- 請求書発行日
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, target_month)
);

CREATE INDEX IF NOT EXISTS idx_shogai_payments_month
  ON shogai_seikyu_payments (target_month, status);

ALTER TABLE shogai_seikyu_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shogai_seikyu_payments_all ON shogai_seikyu_payments;
CREATE POLICY shogai_seikyu_payments_all ON shogai_seikyu_payments
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
