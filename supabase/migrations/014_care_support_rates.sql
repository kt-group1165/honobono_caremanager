-- 年度別 居宅介護支援費 単位数テーブル
-- 改正（約2年ごと）に対応。fiscal_year + care_level でユニーク。
-- 間違った場合は同じ行を UPDATE するだけで差し替え可能。

CREATE TABLE IF NOT EXISTS kaigo_care_support_rates (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fiscal_year TEXT NOT NULL,          -- "2024", "2025" 等（4月始まり）
  care_level TEXT NOT NULL,           -- "要支援1"〜"要介護5"
  units INTEGER NOT NULL,             -- 月あたり単位数
  service_code TEXT NOT NULL,         -- サービスコード
  service_name TEXT NOT NULL,         -- サービス名称
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(fiscal_year, care_level)
);

-- RLS
ALTER TABLE kaigo_care_support_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_all" ON kaigo_care_support_rates FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- トリガー
CREATE TRIGGER update_kaigo_care_support_rates_updated_at
  BEFORE UPDATE ON kaigo_care_support_rates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 令和6年度（2024年4月〜2025年3月）
INSERT INTO kaigo_care_support_rates (fiscal_year, care_level, units, service_code, service_name) VALUES
  ('2024', '要支援1', 438, '461000', '介護予防支援費'),
  ('2024', '要支援2', 438, '461000', '介護予防支援費'),
  ('2024', '要介護1', 1076, '431000', '居宅介護支援費(i)'),
  ('2024', '要介護2', 1076, '431000', '居宅介護支援費(i)'),
  ('2024', '要介護3', 1398, '431100', '居宅介護支援費(ii)'),
  ('2024', '要介護4', 1398, '431100', '居宅介護支援費(ii)'),
  ('2024', '要介護5', 1398, '431100', '居宅介護支援費(ii)')
ON CONFLICT (fiscal_year, care_level) DO NOTHING;

-- 令和7年度（2025年4月〜2027年3月予定）
INSERT INTO kaigo_care_support_rates (fiscal_year, care_level, units, service_code, service_name) VALUES
  ('2025', '要支援1', 443, '461000', '介護予防支援費'),
  ('2025', '要支援2', 443, '461000', '介護予防支援費'),
  ('2025', '要介護1', 1086, '432301', '居宅介護支援費Ⅰⅰ１'),
  ('2025', '要介護2', 1086, '432301', '居宅介護支援費Ⅰⅰ１'),
  ('2025', '要介護3', 1411, '432271', '居宅介護支援費Ⅰⅰ２'),
  ('2025', '要介護4', 1411, '432271', '居宅介護支援費Ⅰⅰ２'),
  ('2025', '要介護5', 1411, '432271', '居宅介護支援費Ⅰⅰ２')
ON CONFLICT (fiscal_year, care_level) DO NOTHING;
