-- AI機能設定
ALTER TABLE kaigo_office_settings ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE kaigo_office_settings ADD COLUMN IF NOT EXISTS ai_api_key TEXT DEFAULT '';
