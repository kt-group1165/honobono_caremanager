-- 040: 緊急時シート追加項目（PDFフォーマット準拠）

-- 基本情報追加
ALTER TABLE kaigo_emergency_sheets ADD COLUMN IF NOT EXISTS home_phone TEXT;        -- 固定電話
ALTER TABLE kaigo_emergency_sheets ADD COLUMN IF NOT EXISTS mobile_phone TEXT;      -- 携帯電話
ALTER TABLE kaigo_emergency_sheets ADD COLUMN IF NOT EXISTS family_members TEXT;    -- 同居家族

-- ADL簡潔版
ALTER TABLE kaigo_emergency_sheets ADD COLUMN IF NOT EXISTS adl_summary TEXT;       -- ADL（簡潔に）

-- 現病と注意点
ALTER TABLE kaigo_emergency_sheets ADD COLUMN IF NOT EXISTS current_disease_notes TEXT; -- 現病と注意点

-- 内服薬（既存medicationsと別に内服薬テキスト）
ALTER TABLE kaigo_emergency_sheets ADD COLUMN IF NOT EXISTS oral_medications TEXT;  -- 内服薬

-- 特別な状況
ALTER TABLE kaigo_emergency_sheets ADD COLUMN IF NOT EXISTS special_situation TEXT; -- 特別な状況

-- 急変時の対応
ALTER TABLE kaigo_emergency_sheets ADD COLUMN IF NOT EXISTS sudden_change_response TEXT; -- 急変時の対応

-- 避難情報
ALTER TABLE kaigo_emergency_sheets ADD COLUMN IF NOT EXISTS evacuation_place_name TEXT;  -- 避難場所（名称）
ALTER TABLE kaigo_emergency_sheets ADD COLUMN IF NOT EXISTS evacuation_place_address TEXT; -- 避難場所（住所）
ALTER TABLE kaigo_emergency_sheets ADD COLUMN IF NOT EXISTS evacuation_notes TEXT;  -- 避難時の注意事項・持参するもの等

-- 緊急連絡先4,5（PDFは5件まで）
ALTER TABLE kaigo_emergency_sheets ADD COLUMN IF NOT EXISTS emergency_contact4_name TEXT;
ALTER TABLE kaigo_emergency_sheets ADD COLUMN IF NOT EXISTS emergency_contact4_relation TEXT;
ALTER TABLE kaigo_emergency_sheets ADD COLUMN IF NOT EXISTS emergency_contact4_phone TEXT;
ALTER TABLE kaigo_emergency_sheets ADD COLUMN IF NOT EXISTS emergency_contact4_address TEXT;
ALTER TABLE kaigo_emergency_sheets ADD COLUMN IF NOT EXISTS emergency_contact5_name TEXT;
ALTER TABLE kaigo_emergency_sheets ADD COLUMN IF NOT EXISTS emergency_contact5_relation TEXT;
ALTER TABLE kaigo_emergency_sheets ADD COLUMN IF NOT EXISTS emergency_contact5_phone TEXT;
ALTER TABLE kaigo_emergency_sheets ADD COLUMN IF NOT EXISTS emergency_contact5_address TEXT;

-- 利用中サービス（JSONB: [{service_type, provider_name, phone, schedule}]）
ALTER TABLE kaigo_emergency_sheets ADD COLUMN IF NOT EXISTS services_in_use JSONB DEFAULT '[]';

-- 充電式を含む電動の医療・介護機器（JSONB: [{item, provider, phone, notes}]）
ALTER TABLE kaigo_emergency_sheets ADD COLUMN IF NOT EXISTS medical_devices JSONB DEFAULT '[]';
