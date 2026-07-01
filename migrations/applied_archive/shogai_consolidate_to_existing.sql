-- ============================================================================
-- 障害福祉 テーブル一本化
--   既存 shougai_certifications に列追加 → 私が作った shogai_recipient_certs /
--   shogai_benefit_allocations を廃止
-- ============================================================================
-- 追加列:
--   self_payment_limit  INT DEFAULT 0        -- 自己負担月額上限 (円)
--   seiho_flag          BOOLEAN DEFAULT false -- 生保連携
--   soudan_office_name  TEXT                  -- 相談支援事業所
--   soudan_manager_name TEXT                  -- 相談支援専門員
--   monthly_allocations JSONB DEFAULT '{}'    -- サービス種別ごとの月間支給量
--                                                (例: { "居宅介護": 5000, "重度訪問介護": 30000 })
--
-- shogai_service_records.cert_id の FK は shougai_certifications に張り替え
-- (旧 shogai_recipient_certs は DROP)
-- ============================================================================

BEGIN;

-- 1) 既存 shougai_certifications に列追加
ALTER TABLE shougai_certifications
  ADD COLUMN IF NOT EXISTS self_payment_limit INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS seiho_flag BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS soudan_office_name TEXT,
  ADD COLUMN IF NOT EXISTS soudan_manager_name TEXT,
  ADD COLUMN IF NOT EXISTS monthly_allocations JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 2) shogai_service_records.cert_id の参照先を差し替え
--    旧: shogai_recipient_certs(id)
--    新: shougai_certifications(id)
ALTER TABLE shogai_service_records
  DROP CONSTRAINT IF EXISTS shogai_service_records_cert_id_fkey;

-- (中身は空のまま張替え。データがあれば手動移行)
ALTER TABLE shogai_service_records
  ADD CONSTRAINT shogai_service_records_cert_id_fkey
  FOREIGN KEY (cert_id) REFERENCES shougai_certifications(id) ON DELETE SET NULL;

-- 3) 旧 テーブル DROP
DROP TABLE IF EXISTS shogai_benefit_allocations CASCADE;
DROP TABLE IF EXISTS shogai_recipient_certs CASCADE;

COMMIT;
