-- 自事業所設定
CREATE TABLE kaigo_office_settings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  office_name TEXT NOT NULL DEFAULT '',
  office_name_kana TEXT DEFAULT '',
  provider_number TEXT DEFAULT '', -- 事業所番号（10桁）
  postal_code TEXT DEFAULT '',
  address TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  fax TEXT DEFAULT '',
  representative_name TEXT DEFAULT '', -- 代表者名
  manager_name TEXT DEFAULT '', -- 管理者名
  -- 特定事業所加算
  tokutei_kassan_type TEXT DEFAULT 'なし' CHECK (tokutei_kassan_type IN ('なし', 'A', 'B', 'C')),
  tokutei_kassan_units INTEGER DEFAULT 0, -- A:505, B:407, C:309
  -- 特定事業所医療介護連携加算
  medical_cooperation_kassan BOOLEAN DEFAULT FALSE,
  medical_cooperation_units INTEGER DEFAULT 0, -- 125単位
  -- 地域区分
  area_category TEXT DEFAULT 'その他', -- 1級地〜7級地、その他
  unit_price NUMERIC DEFAULT 10.00,
  -- その他
  notes TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER update_kaigo_office_settings_updated_at BEFORE UPDATE ON kaigo_office_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE kaigo_office_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_all" ON kaigo_office_settings FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 初期データ（1行のみ）
INSERT INTO kaigo_office_settings (office_name, provider_number, tokutei_kassan_type, tokutei_kassan_units) VALUES
  ('', '', 'なし', 0);
