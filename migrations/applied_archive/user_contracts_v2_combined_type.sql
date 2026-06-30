-- 「契約書兼重要事項説明書」(= 居宅介護支援用 統合書類) を contract_type に追加
--
-- 背景:
--   docx (`apps/kaigo-app/契約書/居宅介護支援/26.6月 契約書原本(大網）.docx`) では
--   契約書と重要事項説明書が 1 つの統合書類として運用されている。
--   既存 4 種類 (重要事項説明書 / 契約書 / 個人情報同意書 / その他) はそのまま残し、
--   5 値目 '契約書兼重要事項説明書' を CHECK 制約で許可する。
--
-- ❗ Supabase SQL Editor 適用時は BEGIN/COMMIT 1 ブロックで Run。
--    COMMIT 忘れると auto rollback される (= memory: feedback_supabase_sql_editor.md)

BEGIN;

ALTER TABLE kaigo_user_contracts
  DROP CONSTRAINT IF EXISTS kaigo_user_contracts_contract_type_check;

ALTER TABLE kaigo_user_contracts
  ADD CONSTRAINT kaigo_user_contracts_contract_type_check
  CHECK (contract_type IN (
    '重要事項説明書',
    '契約書',
    '契約書兼重要事項説明書',
    '個人情報同意書',
    'その他'
  ));

COMMENT ON COLUMN kaigo_user_contracts.contract_type IS
  '5 値: 重要事項説明書 / 契約書 / 契約書兼重要事項説明書 (= 居宅介護支援 統合書類) / 個人情報同意書 / その他';

COMMIT;
