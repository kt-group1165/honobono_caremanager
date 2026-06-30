-- 「契約書兼重要事項説明書」を唯一の contract_type にする (2026-06-29)
--
-- 経緯:
--   元々 5 値 (重要事項説明書 / 契約書 / 契約書兼重要事項説明書 / 個人情報同意書 / その他)
--   だったが、user 確定で「契約書兼重要事項説明書」のみ運用と決定。
--   既存 fake サンプル (= 重要事項説明書 / 契約書) も全 DELETE 済。
--
-- ❗ Supabase SQL Editor で BEGIN; COMMIT; 1 ブロック貼り付け Run。

BEGIN;

-- 旧 CHECK 制約 drop
ALTER TABLE kaigo_user_contracts
  DROP CONSTRAINT IF EXISTS kaigo_user_contracts_contract_type_check;

-- 新 CHECK: 1 値のみ
ALTER TABLE kaigo_user_contracts
  ADD CONSTRAINT kaigo_user_contracts_contract_type_check
  CHECK (contract_type = '契約書兼重要事項説明書');

-- DEFAULT 値も設定 (= INSERT 時に省略可)
ALTER TABLE kaigo_user_contracts
  ALTER COLUMN contract_type SET DEFAULT '契約書兼重要事項説明書';

COMMENT ON COLUMN kaigo_user_contracts.contract_type IS
  '常に "契約書兼重要事項説明書" (= 居宅介護支援の docx に基づく統合書類)';

COMMIT;
