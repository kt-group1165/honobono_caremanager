-- ============================================================================
-- kaigo_service_codes.short_name (略称)
--   狭い枠 (カレンダーセル / タイムライン / モバイル一覧) で使う短縮表記。
--   例: 身体介護3 → 身3、生活援助2 → 生2、身体介護1・生活1 → 身1生1
-- ============================================================================

BEGIN;

ALTER TABLE kaigo_service_codes
  ADD COLUMN IF NOT EXISTS short_name TEXT;

COMMENT ON COLUMN kaigo_service_codes.short_name IS
  '狭い枠で使う略称。UI 側で service_name が長い場合の代替表記。手動 or auto 生成。';

CREATE INDEX IF NOT EXISTS idx_kaigo_service_codes_short_name
  ON kaigo_service_codes (short_name);

COMMIT;
