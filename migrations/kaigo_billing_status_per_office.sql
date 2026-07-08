-- ============================================================================
-- kaigo_billing_status を事業所単位に (UNIQUE に office_id を追加)
-- ============================================================================
-- 2026-07-08。居宅介護支援の請求画面 (/billing/seikyu) でも同テーブルを使うため、
-- 同一利用者が自社の訪問介護と居宅の両方を利用する月に 月遅れ/返戻/過誤 フラグが
-- 共有されてしまう問題を解消する。返戻等は事業所×サービス単位で起こるため
-- (client_id, target_month, office_id) を一意キーにする。
-- 前提確認済み: 適用時点で office_id IS NULL の行は 0 件。

BEGIN;

ALTER TABLE kaigo_billing_status
  ALTER COLUMN office_id SET NOT NULL;

ALTER TABLE kaigo_billing_status
  DROP CONSTRAINT kaigo_billing_status_client_id_target_month_key;

ALTER TABLE kaigo_billing_status
  ADD CONSTRAINT kaigo_billing_status_client_month_office_key
  UNIQUE (client_id, target_month, office_id);

COMMIT;
