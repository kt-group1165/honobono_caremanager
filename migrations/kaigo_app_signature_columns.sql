-- 電子署名 PNG 保存機能 v1
-- 対象 table: kaigo_visit_records (訪問介護実施記録) / kaigo_support_records (支援経過記録 = サービス担当者会議等)
-- 各 table に共通追加: signature_image_url / signed_at / signer_name
-- ※ apply は user 任せ。Supabase SQL Editor では BEGIN; を外して実行 (Editor が auto-rollback する罠回避)

BEGIN;

-- 訪問介護実施記録
ALTER TABLE kaigo_visit_records
  ADD COLUMN IF NOT EXISTS signature_image_url TEXT,
  ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS signer_name TEXT;

COMMENT ON COLUMN kaigo_visit_records.signature_image_url IS '電子署名 PNG の Storage signed URL (signatures bucket)';
COMMENT ON COLUMN kaigo_visit_records.signed_at IS '署名取得日時';
COMMENT ON COLUMN kaigo_visit_records.signer_name IS '署名者氏名 (本人 or 代理)';

-- 支援経過記録 (サービス担当者会議 / モニタリング等)
ALTER TABLE kaigo_support_records
  ADD COLUMN IF NOT EXISTS signature_image_url TEXT,
  ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS signer_name TEXT;

COMMENT ON COLUMN kaigo_support_records.signature_image_url IS '電子署名 PNG の Storage signed URL (signatures bucket)';
COMMENT ON COLUMN kaigo_support_records.signed_at IS '署名取得日時';
COMMENT ON COLUMN kaigo_support_records.signer_name IS '署名者氏名 (本人 or 代理)';

COMMIT;
