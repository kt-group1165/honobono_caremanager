-- ============================================================================
-- 介護請求の状態管理 (発行済 / 国保対象 / 月遅れ / 返戻 / 過誤) — 利用者 × 月
-- ============================================================================
-- ほのぼの「介護請求」タブに倣い、利用者ごとに請求状態とフラグを保持する。
-- 状態遷移: 未発行 → 発行済 (明細書発行) → 国保対象 (伝送対象化)
-- フラグ: 月遅れ / 返戻 / 過誤 (Phase 1 は記録・表示・絞込まで)

BEGIN;

CREATE TABLE IF NOT EXISTS kaigo_billing_status (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL DEFAULT 'kt-group',
  office_id     UUID,
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  target_month  TEXT NOT NULL,                   -- 'YYYY-MM' (サービス提供月)
  issued_at     TIMESTAMPTZ,                     -- 明細書発行日時 (NULL=未発行)
  kokuho_target BOOLEAN NOT NULL DEFAULT false,  -- 国保対象化済み (伝送対象)
  tsukiokure    BOOLEAN NOT NULL DEFAULT false,  -- 月遅れ
  henrei        BOOLEAN NOT NULL DEFAULT false,  -- 返戻
  kago          BOOLEAN NOT NULL DEFAULT false,  -- 過誤
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, target_month)
);

CREATE INDEX IF NOT EXISTS idx_kaigo_billing_status_month
  ON kaigo_billing_status (target_month, kokuho_target);

ALTER TABLE kaigo_billing_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kaigo_billing_status_all ON kaigo_billing_status;
CREATE POLICY kaigo_billing_status_all ON kaigo_billing_status
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
