-- ============================================================================
-- 地域生活支援受給者証 v2: 支給決定期間 (終了日) + 交付日 を追加
--
-- v1 で valid_from (支給決定期間 開始) / notes (備考) は作成済み。
-- 実物の受給者証に合わせ、終了日 (valid_until) と 交付年月日 (issue_date) を足す。
-- 期限管理・更新警告・帳票への交付日印字に使う。
--
-- Supabase SQL Editor に貼って Run。冪等 (IF NOT EXISTS)。
-- ============================================================================

BEGIN;

ALTER TABLE chiiki_recipient_certs ADD COLUMN IF NOT EXISTS issue_date DATE;
ALTER TABLE chiiki_recipient_certs ADD COLUMN IF NOT EXISTS valid_until DATE;

COMMENT ON COLUMN chiiki_recipient_certs.valid_from  IS '支給決定期間 開始';
COMMENT ON COLUMN chiiki_recipient_certs.valid_until IS '支給決定期間 終了';
COMMENT ON COLUMN chiiki_recipient_certs.issue_date  IS '交付年月日';

COMMIT;

-- 確認:
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_name = 'chiiki_recipient_certs' ORDER BY ordinal_position;
-- ロールバック:
-- ALTER TABLE chiiki_recipient_certs DROP COLUMN IF EXISTS issue_date, DROP COLUMN IF EXISTS valid_until;
