-- 036: 訪問記録にcare_record_data JSONB列を追加
-- ケアパレット準拠の全22カテゴリのデータを1つのJSONBに格納

ALTER TABLE kaigo_visit_records ADD COLUMN IF NOT EXISTS care_record_data JSONB DEFAULT '{}';
