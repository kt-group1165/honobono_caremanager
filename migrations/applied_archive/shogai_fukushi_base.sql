-- ============================================================================
-- 障害福祉サービス 基盤テーブル群
-- ============================================================================
-- 対応サービス種別:
--   居宅介護 (身体介護 / 家事援助 / 通院等介助 / 通院等乗降介助)
--   重度訪問介護 (障害支援区分 4-6 対象、長時間見守り含)
--   行動援護 (知的・精神障害 の外出支援)
--   同行援護 (視覚障害 の外出支援)
--
-- 参考法令:
--   障害者総合支援法 / 障害福祉サービス費請求告示 (令和6年報酬改定)
--   国保連 障害福祉サービス費請求 CSV 仕様
--
-- 設計方針:
--   * clients は共有マスタ (介護保険と障害福祉で 1 テーブル共有)
--   * 障害福祉固有の情報 (受給者証・支給決定・障害支援区分等) は
--     shogai_recipient_certs に per-client で保持
--   * サービスコードは 令和6年 単位数表 に準拠 (10 円 × 地域区分単価)
--   * RLS は authenticated 全員 (kaigo-app 内で office フィルタする方針)
-- ============================================================================

BEGIN;

-- ==========================================================================
-- 1. 受給者証・支給決定情報 (障害福祉 per client 情報)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS shogai_recipient_certs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                TEXT NOT NULL,
  client_id                UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

  -- 受給者証情報
  recipient_number         TEXT,                                -- 受給者証番号 (10 桁)
  municipality_code        TEXT,                                -- 保険者番号 (市町村コード 6 桁)
  disability_category      TEXT,                                -- 身体 / 知的 / 精神 / 難病等
  disability_class         INT CHECK (disability_class BETWEEN 1 AND 6),  -- 障害支援区分 (1-6)

  -- 支給決定期間
  benefit_start_date       DATE,
  benefit_end_date         DATE,

  -- 自己負担上限額 (月額)
  self_payment_limit       INT NOT NULL DEFAULT 0,
  self_payment_percent     NUMERIC(5,2) NOT NULL DEFAULT 10.00,  -- 通常 10%

  -- 生保連携
  seiho_flag               BOOLEAN NOT NULL DEFAULT false,

  -- 相談支援事業所・特定相談支援
  soudan_office_name       TEXT,
  soudan_manager_name      TEXT,

  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, benefit_start_date)  -- 期間ごと 1 行
);

-- ==========================================================================
-- 2. 支給決定 (サービス種別ごとの支給量 = 月間上限時間)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS shogai_benefit_allocations (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cert_id                  UUID NOT NULL REFERENCES shogai_recipient_certs(id) ON DELETE CASCADE,
  service_type             TEXT NOT NULL CHECK (service_type IN (
    '居宅介護', '重度訪問介護', '行動援護', '同行援護'
  )),
  monthly_units            INT NOT NULL DEFAULT 0,   -- 月間支給量 (単位)
  monthly_minutes          INT,                       -- 参考: 月間支給時間 (分)
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ==========================================================================
-- 3. 障害福祉サービスコード マスタ
-- ==========================================================================
CREATE TABLE IF NOT EXISTS shogai_service_codes (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fiscal_year              INT NOT NULL DEFAULT 2024,  -- 令和6年報酬改定
  service_type             TEXT NOT NULL,              -- 居宅介護, 重度訪問介護 等
  service_category         TEXT,                        -- 身体介護 / 家事援助 / 通院等介助 等
  code                     TEXT NOT NULL,               -- サービスコード (6 桁)
  name                     TEXT NOT NULL,               -- 例: 「居宅介護 身体介護 30 分未満」
  unit_count               INT NOT NULL,                -- 単位数
  min_minutes              INT,                         -- 適用最低分
  max_minutes              INT,                         -- 適用最高分 (NULL=以降)
  time_bracket             TEXT,                        -- '30分未満' 'X時間Y分〜' 等 表示用
  is_addon                 BOOLEAN NOT NULL DEFAULT false, -- 加算コード
  is_active                BOOLEAN NOT NULL DEFAULT true,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (fiscal_year, code)
);

CREATE INDEX IF NOT EXISTS idx_shogai_service_codes_type
  ON shogai_service_codes (fiscal_year, service_type, is_active);

-- ==========================================================================
-- 4. サービス提供実績記録 (訪問 1 回 = 1 行)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS shogai_service_records (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                TEXT NOT NULL,
  office_id                UUID REFERENCES offices(id) ON DELETE SET NULL,
  client_id                UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  cert_id                  UUID REFERENCES shogai_recipient_certs(id) ON DELETE SET NULL,

  -- サービス提供日時
  service_date             DATE NOT NULL,
  start_time               TIME,
  end_time                 TIME,
  duration_minutes         INT,                              -- 計算値 (end-start)

  -- サービス内容
  service_type             TEXT NOT NULL,                    -- 居宅介護 / 重度訪問介護 等
  service_category         TEXT,                             -- 身体 / 家事 / 通院 等
  service_code             TEXT,                             -- shogai_service_codes.code
  unit_count               INT,                              -- 単位数 (record 時点で確定)

  -- 提供職員
  staff_id                 UUID,                             -- members.id
  staff_name_cached        TEXT,

  -- 加算 (JSONB array of {code, name, units})
  addons                   JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- 記録内容
  activities               TEXT,                             -- 実施内容
  client_condition         TEXT,                             -- 利用者の状態
  family_condition         TEXT,                             -- 家族の状況
  handover_notes           TEXT,                             -- 引継事項

  status                   TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'cancelled')),
  cancel_reason            TEXT,

  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shogai_records_client_date
  ON shogai_service_records (client_id, service_date DESC);
CREATE INDEX IF NOT EXISTS idx_shogai_records_office_date
  ON shogai_service_records (office_id, service_date DESC);

-- ==========================================================================
-- 5. サービス等利用計画書
-- ==========================================================================
CREATE TABLE IF NOT EXISTS shogai_service_use_plans (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                TEXT NOT NULL,
  office_id                UUID REFERENCES offices(id) ON DELETE SET NULL,
  client_id                UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

  plan_no                  INT NOT NULL DEFAULT 1,          -- 第 X 回 計画
  created_date             DATE,
  effective_from           DATE,
  effective_until          DATE,

  -- 意向・希望
  user_wish                TEXT,
  family_wish              TEXT,

  -- 総合的な援助方針
  overall_policy           TEXT,

  -- 長期・短期目標
  long_term_goal           TEXT,
  short_term_goal          TEXT,

  -- 週間サービス計画 (JSONB)
  weekly_schedule          JSONB,

  -- モニタリング頻度 (障害支援区分により 1-6 月)
  monitoring_frequency     INT,

  status                   TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'archived')),
  form_data                JSONB NOT NULL DEFAULT '{}'::jsonb,

  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shogai_plans_client
  ON shogai_service_use_plans (client_id, effective_from DESC);

-- ==========================================================================
-- 6. 月次実績サマリ (計算結果 snapshot)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS shogai_monthly_summaries (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                TEXT NOT NULL,
  office_id                UUID REFERENCES offices(id) ON DELETE SET NULL,
  client_id                UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

  fiscal_year              INT NOT NULL,
  month                    INT NOT NULL CHECK (month BETWEEN 1 AND 12),

  service_type             TEXT NOT NULL,

  -- 集計値
  total_units              INT NOT NULL DEFAULT 0,   -- 合計単位数
  total_amount             INT NOT NULL DEFAULT 0,   -- 給付費 (地域区分適用後)
  user_payment             INT NOT NULL DEFAULT 0,   -- 利用者負担
  benefit_payment          INT NOT NULL DEFAULT 0,   -- 給付費請求額

  record_count             INT NOT NULL DEFAULT 0,

  -- 明細 (詳細集計)
  detail                   JSONB NOT NULL DEFAULT '{}'::jsonb,

  computed_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (office_id, client_id, fiscal_year, month, service_type)
);

CREATE INDEX IF NOT EXISTS idx_shogai_summary_month
  ON shogai_monthly_summaries (fiscal_year, month, office_id);

-- ==========================================================================
-- RLS
-- ==========================================================================
ALTER TABLE shogai_recipient_certs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE shogai_benefit_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE shogai_service_codes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE shogai_service_records    ENABLE ROW LEVEL SECURITY;
ALTER TABLE shogai_service_use_plans  ENABLE ROW LEVEL SECURITY;
ALTER TABLE shogai_monthly_summaries  ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'shogai_recipient_certs',
    'shogai_benefit_allocations',
    'shogai_service_codes',
    'shogai_service_records',
    'shogai_service_use_plans',
    'shogai_monthly_summaries'
  ]) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_all ON %I', t, t);
    EXECUTE format('CREATE POLICY %I_all ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true)', t, t);
  END LOOP;
END$$;

-- updated_at trigger 汎用関数を再利用 (既存 _touch 系があれば使う。無ければ inline)
CREATE OR REPLACE FUNCTION _touch_shogai_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'shogai_recipient_certs',
    'shogai_service_records',
    'shogai_service_use_plans'
  ]) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch_%I ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_touch_%I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION _touch_shogai_updated_at()', t, t);
  END LOOP;
END$$;

COMMIT;
