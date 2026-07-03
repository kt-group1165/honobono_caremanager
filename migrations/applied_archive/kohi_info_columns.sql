-- ============================================================================
-- 介護保険: 公費情報の構造化 (生活保護等) (2026-07-03)
-- ============================================================================
-- 利用者管理編 1-6「公費情報の登録」対応。国保連伝送 (7131 基本情報レコードの
-- 公費1欄 / 7111 公費請求分) に必要な公費負担者番号・受給者番号等を
-- 被保険者証情報 (client_insurance_records) に追加する。
-- 既存の public_expense (フリーテキスト) は表示用として存置。

BEGIN;

ALTER TABLE client_insurance_records
  ADD COLUMN IF NOT EXISTS kohi_hobetsu TEXT,           -- 法別番号 (12=生活保護 等)
  ADD COLUMN IF NOT EXISTS kohi_futansha_number TEXT,   -- 公費負担者番号 (8桁)
  ADD COLUMN IF NOT EXISTS kohi_jukyusha_number TEXT,   -- 公費受給者番号 (7桁)
  ADD COLUMN IF NOT EXISTS kohi_start_date DATE,
  ADD COLUMN IF NOT EXISTS kohi_end_date DATE;

COMMENT ON COLUMN client_insurance_records.kohi_hobetsu IS '公費 法別番号 (12=生活保護, 25=中国残留邦人等)';
COMMENT ON COLUMN client_insurance_records.kohi_futansha_number IS '公費負担者番号 (8桁)';
COMMENT ON COLUMN client_insurance_records.kohi_jukyusha_number IS '公費受給者番号 (7桁)';

COMMIT;
