-- サービスコードマスタ
CREATE TABLE kaigo_service_codes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  service_category TEXT NOT NULL, -- サービス種類区分 (11:訪問介護, 13:訪問看護, 15:通所介護, 16:通所リハ, 21:短期入所, 31:居宅療養管理指導, 43:居宅介護支援, 46:介護予防支援, 17:福祉用具貸与 等)
  service_category_name TEXT NOT NULL, -- サービス種類名称
  service_code TEXT NOT NULL, -- サービスコード (6桁)
  service_name TEXT NOT NULL, -- サービス名称
  units INTEGER NOT NULL DEFAULT 0, -- 単位数
  unit_type TEXT DEFAULT '1回につき', -- 算定単位 (1回につき, 1日につき, 1月につき)
  calculation_type TEXT DEFAULT '基本' CHECK (calculation_type IN ('基本', '加算', '減算')),
  valid_from DATE, -- 適用開始日
  valid_until DATE, -- 適用終了日（NULL=現在有効）
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (service_code)
);

-- サービス事業所マスタ
CREATE TABLE kaigo_service_providers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  provider_number TEXT NOT NULL, -- 事業所番号 (10桁)
  provider_name TEXT NOT NULL, -- 事業所名
  provider_name_kana TEXT, -- 事業所名カナ
  service_categories TEXT[] NOT NULL DEFAULT '{}', -- 提供サービス種類コード配列 ['11','15']
  postal_code TEXT,
  address TEXT,
  phone TEXT,
  fax TEXT,
  manager_name TEXT, -- 管理者名
  unit_price NUMERIC DEFAULT 10.00, -- 地域区分単価
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (provider_number)
);

-- インデックス
CREATE INDEX idx_kaigo_service_codes_category ON kaigo_service_codes(service_category);
CREATE INDEX idx_kaigo_service_codes_code ON kaigo_service_codes(service_code);
CREATE INDEX idx_kaigo_service_providers_number ON kaigo_service_providers(provider_number);
CREATE INDEX idx_kaigo_service_providers_status ON kaigo_service_providers(status);

-- トリガー
CREATE TRIGGER update_kaigo_service_codes_updated_at BEFORE UPDATE ON kaigo_service_codes FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_kaigo_service_providers_updated_at BEFORE UPDATE ON kaigo_service_providers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS
ALTER TABLE kaigo_service_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_service_providers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_all" ON kaigo_service_codes FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON kaigo_service_providers FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 初期データ: 主要サービスコード
INSERT INTO kaigo_service_codes (service_category, service_category_name, service_code, service_name, units, unit_type, calculation_type) VALUES
  -- 居宅介護支援 (43)
  ('43', '居宅介護支援', '431000', '居宅介護支援費(i)(要介護1・2)', 1076, '1月につき', '基本'),
  ('43', '居宅介護支援', '431100', '居宅介護支援費(ii)(要介護3・4・5)', 1398, '1月につき', '基本'),
  ('43', '居宅介護支援', '432000', '初回加算', 300, '1月につき', '加算'),
  ('43', '居宅介護支援', '432100', '入院時情報連携加算(i)', 250, '1回につき', '加算'),
  ('43', '居宅介護支援', '432110', '入院時情報連携加算(ii)', 200, '1回につき', '加算'),
  ('43', '居宅介護支援', '432200', '退院・退所加算(i)イ', 450, '1回につき', '加算'),
  ('43', '居宅介護支援', '432210', '退院・退所加算(i)ロ', 600, '1回につき', '加算'),
  ('43', '居宅介護支援', '432300', '通院時情報連携加算', 50, '1月につき', '加算'),
  ('43', '居宅介護支援', '432400', '特定事業所加算(A)', 505, '1月につき', '加算'),
  ('43', '居宅介護支援', '432500', 'ターミナルケアマネジメント加算', 400, '1月につき', '加算'),
  -- 介護予防支援 (46)
  ('46', '介護予防支援', '461000', '介護予防支援費', 438, '1月につき', '基本'),
  ('46', '介護予防支援', '462000', '初回加算', 300, '1月につき', '加算'),
  -- 訪問介護 (11)
  ('11', '訪問介護', '111111', '身体介護1（20分以上30分未満）', 250, '1回につき', '基本'),
  ('11', '訪問介護', '111112', '身体介護2（30分以上1時間未満）', 396, '1回につき', '基本'),
  ('11', '訪問介護', '111113', '身体介護3（1時間以上1時間半未満）', 579, '1回につき', '基本'),
  ('11', '訪問介護', '111211', '生活援助1（20分以上45分未満）', 183, '1回につき', '基本'),
  ('11', '訪問介護', '111212', '生活援助2（45分以上）', 225, '1回につき', '基本'),
  ('11', '訪問介護', '111311', '身体1生活1', 333, '1回につき', '基本'),
  ('11', '訪問介護', '116000', '初回加算', 200, '1月につき', '加算'),
  ('11', '訪問介護', '116100', '生活機能向上連携加算', 100, '1月につき', '加算'),
  -- 訪問看護 (13)
  ('13', '訪問看護', '131111', '訪問看護費(i)1（20分未満）', 313, '1回につき', '基本'),
  ('13', '訪問看護', '131112', '訪問看護費(i)2（30分未満）', 470, '1回につき', '基本'),
  ('13', '訪問看護', '131113', '訪問看護費(i)3（30分以上1時間未満）', 821, '1回につき', '基本'),
  ('13', '訪問看護', '131114', '訪問看護費(i)4（1時間以上1時間半未満）', 1125, '1回につき', '基本'),
  ('13', '訪問看護', '136000', '初回加算', 300, '1月につき', '加算'),
  -- 通所介護 (15)
  ('15', '通所介護', '151111', '通所介護費(i)1（3時間以上4時間未満・要介護1）', 368, '1回につき', '基本'),
  ('15', '通所介護', '151112', '通所介護費(i)1（3時間以上4時間未満・要介護2）', 421, '1回につき', '基本'),
  ('15', '通所介護', '151113', '通所介護費(i)1（3時間以上4時間未満・要介護3）', 477, '1回につき', '基本'),
  ('15', '通所介護', '151211', '通所介護費(i)2（5時間以上6時間未満・要介護1）', 567, '1回につき', '基本'),
  ('15', '通所介護', '151212', '通所介護費(i)2（5時間以上6時間未満・要介護2）', 670, '1回につき', '基本'),
  ('15', '通所介護', '151213', '通所介護費(i)2（5時間以上6時間未満・要介護3）', 773, '1回につき', '基本'),
  ('15', '通所介護', '151311', '通所介護費(i)3（7時間以上8時間未満・要介護1）', 655, '1回につき', '基本'),
  ('15', '通所介護', '151312', '通所介護費(i)3（7時間以上8時間未満・要介護2）', 773, '1回につき', '基本'),
  ('15', '通所介護', '151313', '通所介護費(i)3（7時間以上8時間未満・要介護3）', 896, '1回につき', '基本'),
  ('15', '通所介護', '156000', '入浴介助加算(i)', 40, '1日につき', '加算'),
  ('15', '通所介護', '156100', '個別機能訓練加算(i)イ', 56, '1日につき', '加算'),
  -- 通所リハ (16)
  ('16', '通所リハビリテーション', '161111', '通所リハ費(i)1（1時間以上2時間未満・要介護1）', 366, '1回につき', '基本'),
  ('16', '通所リハビリテーション', '161112', '通所リハ費(i)1（1時間以上2時間未満・要介護2）', 398, '1回につき', '基本'),
  ('16', '通所リハビリテーション', '161113', '通所リハ費(i)1（1時間以上2時間未満・要介護3）', 429, '1回につき', '基本'),
  ('16', '通所リハビリテーション', '161211', '通所リハ費(i)2（3時間以上4時間未満・要介護1）', 483, '1回につき', '基本'),
  ('16', '通所リハビリテーション', '166000', 'リハビリテーション提供体制加算', 12, '1日につき', '加算'),
  -- 短期入所 (21)
  ('21', '短期入所生活介護', '211111', '短期入所生活介護費(i)1（従来型個室・要介護1）', 596, '1日につき', '基本'),
  ('21', '短期入所生活介護', '211112', '短期入所生活介護費(i)1（従来型個室・要介護2）', 665, '1日につき', '基本'),
  ('21', '短期入所生活介護', '211113', '短期入所生活介護費(i)1（従来型個室・要介護3）', 737, '1日につき', '基本'),
  -- 福祉用具貸与 (17)
  ('17', '福祉用具貸与', '171000', '福祉用具貸与費', 0, '1月につき', '基本'),
  -- 訪問リハ (14)
  ('14', '訪問リハビリテーション', '141111', '訪問リハビリテーション費(i)', 307, '1回につき', '基本'),
  ('14', '訪問リハビリテーション', '146000', '短期集中リハ実施加算', 200, '1日につき', '加算');
