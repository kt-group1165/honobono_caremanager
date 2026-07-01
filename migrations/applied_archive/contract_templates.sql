-- ============================================================================
-- kaigo_contract_templates
--  = 契約書フォーマットのマスタ (= 版管理 & 有効化)
-- ----------------------------------------------------------------------------
-- 設計方針:
--   * kind (例: '契約書兼重要事項説明書') × version_no でユニーク
--   * 同時に is_active = true な行は kind ごと 1 つ (index で強制)
--   * content jsonb に全 key (article_01〜22, juyo_*, preamble, closing 等) を格納
--   * 「契約時点の版で凍結」 → kaigo_user_contracts.template_version_no を FK 相当で保存
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS kaigo_contract_templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          TEXT NOT NULL DEFAULT '契約書兼重要事項説明書',
  version_no    INT  NOT NULL,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  is_active     BOOLEAN NOT NULL DEFAULT false,
  content       JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, version_no)
);

-- kind ごとに is_active = true は 1 行だけ
CREATE UNIQUE INDEX IF NOT EXISTS uniq_contract_templates_active_per_kind
  ON kaigo_contract_templates (kind)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_contract_templates_kind_ver
  ON kaigo_contract_templates (kind, version_no DESC);

-- updated_at 自動更新
CREATE OR REPLACE FUNCTION _touch_contract_templates_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_contract_templates_updated_at ON kaigo_contract_templates;
CREATE TRIGGER trg_touch_contract_templates_updated_at
  BEFORE UPDATE ON kaigo_contract_templates
  FOR EACH ROW EXECUTE FUNCTION _touch_contract_templates_updated_at();

-- kaigo_user_contracts に締結時点の version を凍結する列を追加
ALTER TABLE kaigo_user_contracts
  ADD COLUMN IF NOT EXISTS template_version_no INT;

-- RLS: 全 authenticated が SELECT、group_admin だけ INSERT/UPDATE (= 本社管轄)
ALTER TABLE kaigo_contract_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contract_templates_select_all ON kaigo_contract_templates;
CREATE POLICY contract_templates_select_all ON kaigo_contract_templates
  FOR SELECT
  TO authenticated
  USING (true);

-- INSERT/UPDATE/DELETE は group_admin のみ (= tenant_id in ('kt-group') な admin を想定)
-- 簡易実装: members.role_tenant で group_admin ロールを判定するヘルパーは未整備なので、
-- 一旦 authenticated 全員を許可 (= 実運用前に絞る)
DROP POLICY IF EXISTS contract_templates_write_admin ON kaigo_contract_templates;
CREATE POLICY contract_templates_write_admin ON kaigo_contract_templates
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

COMMIT;
