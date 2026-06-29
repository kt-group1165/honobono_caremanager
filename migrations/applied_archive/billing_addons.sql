-- ============================================================
-- 加算管理 (= 介護報酬告示の各種加算を office ごとに登録 / 管理)
-- 2026-06-29 user 確定
-- ============================================================
-- 仕様:
--   - 事業所 (office) + 業種 (居宅介護支援 / 訪問介護) 単位で加算を登録
--   - addon_code: enum (= ハードコード一覧、UI 側で business_type 別 dropdown)
--   - addon_unit: 単位数 (= 算定 1 回あたりの介護報酬単位)
--   - status: active / expired / pending
--   - applied_from: 算定開始日 (NOT NULL)
--   - expires_at: 算定終了日 (= 届出更新前の任意期限)
--   - notification_filed_at: 届出受理日
--   - basis_documents: 算定根拠 (= テキスト or PDF link)
--   - UNIQUE (office_id, addon_code, applied_from): 同 office で同 code を同日付で多重登録不可
--   - hard delete (= 履歴保持は status='expired' で表現)
--
-- 用途:
--   - /addons (= 両版共通の menu) で CRUD
--   - 加算届出の管理 / 算定根拠記録 / 期限管理
--
-- RLS:
--   - 他 kaigo_* 系と同 pattern (= authenticated 全許可)
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS kaigo_billing_addons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  office_id UUID NOT NULL,                  -- 加算は office 単位
  business_type TEXT NOT NULL CHECK (business_type IN ('居宅介護支援', '訪問介護')),
  addon_code TEXT NOT NULL,                 -- enum (例: '特定事業所加算Ⅰ', '緊急時訪問加算', '初回加算' 等)
  addon_unit INTEGER,                       -- 単位数 (例: 505)
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'pending')),
  applied_from DATE NOT NULL,               -- 算定開始日
  expires_at DATE,                          -- 算定終了日 (= 届出更新前)
  notification_filed_at DATE,               -- 届出受理日
  basis_documents TEXT,                     -- 算定根拠 (= テキスト or PDF link)
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  UNIQUE (office_id, addon_code, applied_from)
);

CREATE INDEX IF NOT EXISTS idx_kaigo_billing_addons_office
  ON kaigo_billing_addons(office_id);

CREATE INDEX IF NOT EXISTS idx_kaigo_billing_addons_tenant
  ON kaigo_billing_addons(tenant_id);

CREATE INDEX IF NOT EXISTS idx_kaigo_billing_addons_office_business
  ON kaigo_billing_addons(office_id, business_type);

COMMENT ON TABLE kaigo_billing_addons IS
  '加算管理 (= 介護報酬告示の各種加算を office ごとに登録 / 管理)。居宅・訪問介護 両版で使う。';

-- RLS
ALTER TABLE kaigo_billing_addons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS billing_addons_auth
  ON kaigo_billing_addons;
CREATE POLICY billing_addons_auth
  ON kaigo_billing_addons FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- updated_at 自動更新 trigger
CREATE OR REPLACE FUNCTION trg_kaigo_billing_addons_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS kaigo_billing_addons_updated_at
  ON kaigo_billing_addons;
CREATE TRIGGER kaigo_billing_addons_updated_at
  BEFORE UPDATE ON kaigo_billing_addons
  FOR EACH ROW
  EXECUTE FUNCTION trg_kaigo_billing_addons_updated_at();

COMMIT;
