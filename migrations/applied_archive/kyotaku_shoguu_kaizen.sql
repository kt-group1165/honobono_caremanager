-- 居宅介護支援 処遇改善加算 (令和6〜) 対応
--   居宅介護支援費レセプトに処遇改善加算 (base+各加算 の総単位 × 率) を持たせる。
--   率・コードは事業所単位 (offices) に持つ (自治体/加算区分で異なるため)。
--   例: 大網白里の居宅は 436191 = 2.1% (permil=21)。
BEGIN;

ALTER TABLE kaigo_care_support_claims
  ADD COLUMN IF NOT EXISTS shoguu_kaizen_units integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shoguu_kaizen_code text;

ALTER TABLE offices
  ADD COLUMN IF NOT EXISTS care_support_shoguu_code text,
  ADD COLUMN IF NOT EXISTS care_support_shoguu_permil integer NOT NULL DEFAULT 0;

COMMIT;
