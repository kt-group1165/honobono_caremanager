-- 033_fix_tokutei_check.sql
-- kaigo_office_settings.tokutei_kassan_type の CHECK 制約を緩和
-- 旧: ('なし', 'A', 'B', 'C') のみ
-- 新: ('なし', 'none', 'A', 'B', 'C', 'Ⅰ', 'Ⅱ', 'Ⅲ') を許可

ALTER TABLE kaigo_office_settings
  DROP CONSTRAINT IF EXISTS kaigo_office_settings_tokutei_kassan_type_check;

ALTER TABLE kaigo_office_settings
  ADD CONSTRAINT kaigo_office_settings_tokutei_kassan_type_check
  CHECK (tokutei_kassan_type IS NULL OR tokutei_kassan_type IN ('なし', 'none', 'A', 'B', 'C', 'Ⅰ', 'Ⅱ', 'Ⅲ'));
