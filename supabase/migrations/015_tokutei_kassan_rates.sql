-- 年度別 特定事業所加算 単位数テーブル
-- fiscal_year + business_type + kassan_type でユニーク
-- 居宅介護支援・訪問介護などで共通利用

CREATE TABLE IF NOT EXISTS kaigo_tokutei_kassan_rates (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fiscal_year TEXT NOT NULL,          -- "2024", "2025" 等
  business_type TEXT NOT NULL,        -- "居宅介護支援", "訪問介護" 等
  kassan_type TEXT NOT NULL,          -- "Ⅰ", "Ⅱ", "Ⅲ", "A"
  units INTEGER NOT NULL,             -- 月あたり単位数
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(fiscal_year, business_type, kassan_type)
);

ALTER TABLE kaigo_tokutei_kassan_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_all" ON kaigo_tokutei_kassan_rates;
CREATE POLICY "authenticated_all" ON kaigo_tokutei_kassan_rates FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS update_kaigo_tokutei_kassan_rates_updated_at ON kaigo_tokutei_kassan_rates;
CREATE TRIGGER update_kaigo_tokutei_kassan_rates_updated_at
  BEFORE UPDATE ON kaigo_tokutei_kassan_rates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 令和6年度（2024年4月〜）居宅介護支援
INSERT INTO kaigo_tokutei_kassan_rates (fiscal_year, business_type, kassan_type, units) VALUES
  ('2024', '居宅介護支援', 'Ⅰ', 519),
  ('2024', '居宅介護支援', 'Ⅱ', 421),
  ('2024', '居宅介護支援', 'Ⅲ', 323),
  ('2024', '居宅介護支援', 'A', 114)
ON CONFLICT (fiscal_year, business_type, kassan_type) DO NOTHING;

-- 令和7年度（2025年4月〜）居宅介護支援（改定なければ同値）
INSERT INTO kaigo_tokutei_kassan_rates (fiscal_year, business_type, kassan_type, units) VALUES
  ('2025', '居宅介護支援', 'Ⅰ', 519),
  ('2025', '居宅介護支援', 'Ⅱ', 421),
  ('2025', '居宅介護支援', 'Ⅲ', 323),
  ('2025', '居宅介護支援', 'A', 114)
ON CONFLICT (fiscal_year, business_type, kassan_type) DO NOTHING;
