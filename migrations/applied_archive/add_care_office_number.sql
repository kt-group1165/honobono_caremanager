-- ============================================================================
-- 担当居宅介護支援事業所番号 (外部ケアマネ事業所) の直接入力用列 (2026-07-07)
-- ============================================================================
-- 様式第二 ⑦居宅サービス計画欄 / 7131 基本情報レコードの
-- 「居宅サービス計画作成 事業所番号(10桁)」を埋めるため。
-- 訪問介護の担当居宅は外部ケアマネ事業所が大半で自社 offices に無いため、
-- care_office_id(自社office参照) とは別に 10桁番号を直接テキスト保持する。
-- aggregate は care_office_number を優先、無ければ care_office_id を解決。

BEGIN;

ALTER TABLE client_insurance_records
  ADD COLUMN IF NOT EXISTS care_office_number TEXT;   -- 担当居宅事業所番号(10桁)
ALTER TABLE client_insurance_records
  ADD COLUMN IF NOT EXISTS care_office_name TEXT;      -- 担当居宅事業所名(任意)

COMMENT ON COLUMN client_insurance_records.care_office_number
  IS '担当居宅介護支援事業所番号(10桁)。様式第二⑦/7131基本情報レコード用。外部ケアマネ事業所を直接入力';

COMMIT;
