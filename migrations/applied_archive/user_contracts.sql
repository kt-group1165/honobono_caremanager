-- 重要事項説明書 / 契約書 管理 (= 居宅・訪問介護 両版共通)
--
-- 目的:
--   利用開始時に交付する 重要事項説明書 / 契約書 / 個人情報同意書 等を
--   利用者ごとに保管し、いつ / どの版を交付したかを後から確認可能にする。
--
-- 設計方針:
--   1) 利用者は共有マスタ clients を参照 (kaigo_user_contracts.user_id → clients.id)
--   2) office_id は nullable (= 1 利用者が複数 office と契約可)
--   3) contract_type / status は CHECK 制約で限定
--   4) content (JSONB) に section ごとの form 値を格納 (= schema-less)
--   5) RLS は authenticated に対し open (= 既存 kaigo_* table と同方針)
--
-- ❗ Supabase SQL Editor 適用時は BEGIN/COMMIT 1 ブロックで Run。
--    COMMIT 忘れると auto rollback される (= memory: feedback_supabase_sql_editor.md)

BEGIN;

CREATE TABLE IF NOT EXISTS kaigo_user_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  office_id UUID,                                  -- 契約 office (任意)
  contract_type TEXT NOT NULL CHECK (contract_type IN (
    '重要事項説明書', '契約書', '個人情報同意書', 'その他'
  )),
  business_type TEXT,                              -- '居宅介護支援' / '訪問介護' / 等
  issued_date DATE NOT NULL,                       -- 交付日
  effective_from DATE,                             -- 効力発生日
  effective_until DATE,                            -- 有効期間 終了 (= null は無期限)
  signed_at DATE,                                  -- 署名取得日
  signed_by_name TEXT,                             -- 署名者 (= 本人 or 代理人)
  signed_by_relation TEXT,                         -- 続柄 (= 「本人」「長男」等)
  content JSONB NOT NULL DEFAULT '{}'::jsonb,     -- 契約書本文 (= form 各欄)
  attachment_url TEXT,                             -- スキャン PDF link (任意)
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'archived')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID
);

CREATE INDEX IF NOT EXISTS idx_kaigo_user_contracts_user
  ON kaigo_user_contracts(user_id);
CREATE INDEX IF NOT EXISTS idx_kaigo_user_contracts_tenant
  ON kaigo_user_contracts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_kaigo_user_contracts_office
  ON kaigo_user_contracts(office_id);
CREATE INDEX IF NOT EXISTS idx_kaigo_user_contracts_type_status
  ON kaigo_user_contracts(contract_type, status);

-- RLS
ALTER TABLE kaigo_user_contracts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_contracts_auth ON kaigo_user_contracts;
CREATE POLICY user_contracts_auth
  ON kaigo_user_contracts
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- updated_at trigger
CREATE OR REPLACE FUNCTION trg_kaigo_user_contracts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS kaigo_user_contracts_updated_at ON kaigo_user_contracts;
CREATE TRIGGER kaigo_user_contracts_updated_at
  BEFORE UPDATE ON kaigo_user_contracts
  FOR EACH ROW
  EXECUTE FUNCTION trg_kaigo_user_contracts_updated_at();

COMMENT ON TABLE kaigo_user_contracts IS
  '重要事項説明書 / 契約書 等の利用者ごと交付書類管理 (居宅・訪問介護 共通)';
COMMENT ON COLUMN kaigo_user_contracts.content IS
  '契約書本文 JSONB: { company_name, company_address, operating_hours, fee_structure, complaint_contact, ... } など section 別';

COMMIT;
