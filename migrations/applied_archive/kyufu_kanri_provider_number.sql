-- 給付管理票 (8221) を実データで再現するための拡張。
--   居宅の給付管理は「提供事業所 (他社) × サービス種類」単位。
--   1) service_kind_code: CSV 由来のサービス種類コードを直接保持
--      (72=認知症対応型通所介護 / 78=地域密着型通所介護 等 SERVICE_KIND_CODE
--       マップに無い/旧居宅コードと異なる種別があるため、名称からの再導出は不可)。
--   2) provider_number: 提供事業所番号 (他社は offices に無く name 解決不能なので直接保持)。
--      NOT NULL DEFAULT '' 化し複合ユニークキーに使う。
--   3) ユニーク制約に provider_number を追加。
--      同一利用者が同一サービス種類を複数事業所から受けるケース (大網居宅で 10 件) を
--      別行で保持するため。旧 (user_id, billing_month, service_type) では潰れていた。
BEGIN;

ALTER TABLE kaigo_benefit_management
  ADD COLUMN IF NOT EXISTS service_kind_code text;

-- provider_number を空文字既定・NOT NULL 化
UPDATE kaigo_benefit_management SET provider_number = '' WHERE provider_number IS NULL;
ALTER TABLE kaigo_benefit_management
  ALTER COLUMN provider_number SET DEFAULT '',
  ALTER COLUMN provider_number SET NOT NULL;

-- 旧ユニーク制約 (user_id, billing_month, service_type) を撤去
DO $$
DECLARE cn text;
BEGIN
  SELECT conname INTO cn FROM pg_constraint
   WHERE conrelid = 'kaigo_benefit_management'::regclass
     AND contype = 'u'
     AND pg_get_constraintdef(oid) LIKE '%(user_id, billing_month, service_type)%';
  IF cn IS NOT NULL THEN
    EXECUTE format('ALTER TABLE kaigo_benefit_management DROP CONSTRAINT %I', cn);
  END IF;
END $$;
-- 制約でなく bare unique index だった場合の掃除
DROP INDEX IF EXISTS kaigo_benefit_management_user_id_billing_month_service_type_key;

-- 提供事業所を含む複合ユニークへ
ALTER TABLE kaigo_benefit_management
  ADD CONSTRAINT kaigo_benefit_management_uk
  UNIQUE (user_id, billing_month, service_type, provider_number);

COMMIT;
