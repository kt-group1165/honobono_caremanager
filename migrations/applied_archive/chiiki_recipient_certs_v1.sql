-- ============================================================================
-- 地域生活支援受給者証 (移動支援・訪問入浴[障害] の 障害者受給者証)
--
-- 背景: 移動支援/訪問入浴(地域生活支援) の請求では、障害福祉サービス受給者証とは
-- 別に「地域生活支援受給者証」があり、受給者証番号・契約支給量(例 移動支援 月25時間)・
-- 利用者負担上限月額を記録する。これまで idou-billing は障害福祉受給者証を流用して
-- いたが、番号や支給量が異なるため専用ストアを持つ。
--
--   shikyu_amount_text = 実績記録票の「契約支給量」欄にそのまま印字する自由文
--   shikyu_minutes     = 支給量の分換算 (移動支援記録の支給量超過警告の閾値。null=標準25h)
--
-- Supabase SQL Editor に貼って Run。冪等 (IF NOT EXISTS)。
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS chiiki_recipient_certs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL DEFAULT 'kt-group',
  municipality TEXT NOT NULL DEFAULT '千葉市',
  -- 受給者証番号
  beneficiary_number TEXT,
  -- 契約支給量 (実績記録票にそのまま印字する自由文。例「移動支援 月25時間」)
  shikyu_amount_text TEXT,
  -- 支給量の分換算 (超過警告の閾値)。null = 標準支給量25時間
  shikyu_minutes INTEGER,
  -- 利用者負担上限月額 (円)。0 = 無料 (非課税)
  self_payment_limit INTEGER NOT NULL DEFAULT 0,
  -- 生活保護 (= 負担なし)
  seiho_flag BOOLEAN NOT NULL DEFAULT false,
  valid_from DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 1利用者 × 1市町村 は1行
  UNIQUE (client_id, municipality)
);

CREATE INDEX IF NOT EXISTS idx_chiiki_certs_client ON chiiki_recipient_certs (client_id);

DROP TRIGGER IF EXISTS trg_chiiki_certs_updated_at ON chiiki_recipient_certs;
CREATE TRIGGER trg_chiiki_certs_updated_at
  BEFORE UPDATE ON chiiki_recipient_certs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE chiiki_recipient_certs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_all" ON chiiki_recipient_certs;
CREATE POLICY "authenticated_all" ON chiiki_recipient_certs
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;

-- 確認:
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_name = 'chiiki_recipient_certs' ORDER BY ordinal_position;
-- ロールバック:
-- DROP TABLE IF EXISTS chiiki_recipient_certs;
