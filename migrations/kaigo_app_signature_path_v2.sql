-- 電子署名 v2: Storage path 保存方式に refactor
-- v1 は signature_image_url に 1 年期限の signed URL を直接保存していたため、1 年経過後 <img src> が token 失効で表示不可に。
-- v2 では Storage path (signatures bucket からの relative path) を保存し、表示時に毎回 createSignedUrl(path, 3600) で動的発行する。
--
-- 既存 signature_image_url 列は deprecated (UI は path 優先 → URL fallback)。
-- backfill は migrations/kaigo_app_signature_path_backfill.mjs を参照。
--
-- ※ Supabase SQL Editor で apply する場合は BEGIN; / COMMIT; を外す (Editor は auto-rollback する罠あり)

BEGIN;

ALTER TABLE kaigo_visit_records
  ADD COLUMN IF NOT EXISTS signature_image_path TEXT;

ALTER TABLE kaigo_support_records
  ADD COLUMN IF NOT EXISTS signature_image_path TEXT;

COMMENT ON COLUMN kaigo_visit_records.signature_image_path IS
  'Storage path (signatures bucket からの相対 path、例: kt-group/kaigo_visit_records/<uuid>.png)。表示時に createSignedUrl で動的発行する。v1 の signature_image_url は deprecated。';
COMMENT ON COLUMN kaigo_support_records.signature_image_path IS
  'Storage path (signatures bucket からの相対 path、例: kt-group/kaigo_support_records/<uuid>.png)。表示時に createSignedUrl で動的発行する。v1 の signature_image_url は deprecated。';

COMMIT;
