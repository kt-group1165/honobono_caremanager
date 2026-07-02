-- ============================================================================
-- kaigo_service_codes 性能 index (2026-07-02)
-- ============================================================================
-- 介護請求 / 提供表 / 月間個別 の単位数 lookup は
--   service_name IN (...) AND calculation_type='基本'
-- で引くが、118,000 行超に対し service_name に index が無く、
-- authenticated (RLS 評価込み) の seq scan が statement timeout になる。
--   エラー: サービスコード取得失敗: canceling statement due to statement timeout

BEGIN;

-- 単位数 lookup (service_name IN 検索)
CREATE INDEX IF NOT EXISTS idx_service_codes_service_name
  ON kaigo_service_codes (service_name);

-- サービス選択ダイアログ (system + category + 有効期間で page-loop)
CREATE INDEX IF NOT EXISTS idx_service_codes_system_category
  ON kaigo_service_codes (system, service_category, valid_from);

-- 請求集計の被保険者証 lookup (client_id + 最新 effective_date)
CREATE INDEX IF NOT EXISTS idx_insurance_records_client
  ON client_insurance_records (client_id, effective_date DESC);

COMMIT;
