-- 044: 複数自事業所対応
-- kaigo_office_settings を複数事業所対応に拡張（business_type 追加）

-- business_type列を追加（ケアマネ/訪問介護）
ALTER TABLE kaigo_office_settings ADD COLUMN IF NOT EXISTS business_type TEXT DEFAULT 'care_manager';
-- 値: 'care_manager' | 'home_care' | 'day_service' 等
COMMENT ON COLUMN kaigo_office_settings.business_type IS 'ケアマネ/訪問介護など事業種別';

-- is_active列（複数ある中でアクティブな事業所が複数あってもOK、一覧で並べる）
ALTER TABLE kaigo_office_settings ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

-- created_at列
ALTER TABLE kaigo_office_settings ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

-- 利用者の自事業所利用状況テーブル
CREATE TABLE IF NOT EXISTS kaigo_user_office_services (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id) ON DELETE CASCADE,
  office_id UUID NOT NULL REFERENCES kaigo_office_settings(id) ON DELETE CASCADE,
  start_date DATE,                     -- サービス開始日
  end_date DATE,                       -- サービス終了日（NULL=現在継続中）
  service_notes TEXT,                  -- メモ
  is_active BOOLEAN DEFAULT TRUE,      -- 現在このサービスを利用中か
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, office_id)
);

CREATE INDEX IF NOT EXISTS idx_user_office_services_user ON kaigo_user_office_services(user_id);
CREATE INDEX IF NOT EXISTS idx_user_office_services_office ON kaigo_user_office_services(office_id);

ALTER TABLE kaigo_user_office_services ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_all" ON kaigo_user_office_services FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Phase3用（後日）: 主要テーブルに office_id 列を追加（nullable、既存データは null のまま）
-- ALTER TABLE kaigo_care_plans ADD COLUMN IF NOT EXISTS office_id UUID REFERENCES kaigo_office_settings(id);
-- ALTER TABLE kaigo_visit_schedule ADD COLUMN IF NOT EXISTS office_id UUID REFERENCES kaigo_office_settings(id);
-- ALTER TABLE kaigo_visit_records ADD COLUMN IF NOT EXISTS office_id UUID REFERENCES kaigo_office_settings(id);
-- ALTER TABLE kaigo_support_records ADD COLUMN IF NOT EXISTS office_id UUID REFERENCES kaigo_office_settings(id);
