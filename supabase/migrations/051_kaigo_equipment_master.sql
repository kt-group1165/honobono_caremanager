-- 福祉用具マスタ (kaigo-app 独立)
-- ケアマネが利用票に「福祉用具貸与」サービスを追加する際に選択する用具マスタ。
-- order-app の equipment_master とは別系統 (初期 seed は order-app からコピー予定)。
CREATE TABLE kaigo_equipment_master (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,

  -- 14 種目 (国の福祉用具貸与カテゴリ)
  category TEXT NOT NULL CHECK (category IN (
    '車椅子', '車椅子付属品',
    '特殊寝台', '特殊寝台付属品',
    '床ずれ防止用具', '体位変換器',
    '手すり', 'スロープ',
    '歩行器', '歩行補助つえ',
    '認知症老人徘徊感知機器', '移動用リフト',
    '自動排泄処理装置', '排泄予測支援機器'
  )),

  product_code TEXT,             -- 商品コード (任意、order-app 由来なら埋める)
  product_name TEXT NOT NULL,    -- 商品名 (例: "楽匠Z 3モーション83cm幅ミニ KQ-7302")
  provider_name TEXT,            -- 提供福祉用具事業所名 (free text、自社外も可)
  default_units INT,             -- 標準単位数 (空なら手入力 only、参考値)
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, product_code, provider_name)
);

CREATE INDEX idx_kaigo_equipment_tenant_category
  ON kaigo_equipment_master (tenant_id, category, is_active);

-- updated_at 自動更新 (他 master と同じ pattern)
CREATE TRIGGER update_kaigo_equipment_master_updated_at
  BEFORE UPDATE ON kaigo_equipment_master
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS (kaigo-app の他 master と同じ pattern、authenticated 全許可)
ALTER TABLE kaigo_equipment_master ENABLE ROW LEVEL SECURITY;
CREATE POLICY kaigo_equipment_master_authenticated ON kaigo_equipment_master
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
