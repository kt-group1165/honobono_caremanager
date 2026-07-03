-- ============================================================================
-- 利用料の入金管理 + 利用者の口座情報 (2026-07-03)
-- ============================================================================
-- ほのぼの 請求 Q-4/Q-5 (入金処理)・利用請求タブの未収金管理、
-- 利用者管理編 1-15 (口座情報の登録) に対応。

BEGIN;

-- 1) 利用者の口座情報 (口座振替用)
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS bank_name TEXT,
  ADD COLUMN IF NOT EXISTS bank_branch TEXT,
  ADD COLUMN IF NOT EXISTS bank_account_type TEXT,   -- 普通 / 当座
  ADD COLUMN IF NOT EXISTS bank_account_number TEXT,
  ADD COLUMN IF NOT EXISTS bank_account_holder TEXT;

COMMENT ON COLUMN clients.bank_name IS '利用料 口座振替: 金融機関名';
COMMENT ON COLUMN clients.bank_account_holder IS '利用料 口座振替: 口座名義 (カナ)';

-- 2) 利用料請求の入金状況 (利用者 × 月)
CREATE TABLE IF NOT EXISTS riyou_seikyu_payments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL DEFAULT 'kt-group',
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  target_month   TEXT NOT NULL,               -- 'YYYY-MM' (サービス提供月)
  billed_amount  INT NOT NULL DEFAULT 0,      -- 請求額 (発行時点の額を記録)
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

CREATE INDEX IF NOT EXISTS idx_riyou_payments_month
  ON riyou_seikyu_payments (target_month, status);

ALTER TABLE riyou_seikyu_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS riyou_seikyu_payments_all ON riyou_seikyu_payments;
CREATE POLICY riyou_seikyu_payments_all ON riyou_seikyu_payments
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
