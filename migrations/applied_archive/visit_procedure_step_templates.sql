-- ============================================================
-- 訪問介護手順書 step テンプレート (= サービス内容 + 具体的取り組内容 の master)
-- 2026-06-22 user 確定
-- ============================================================
-- 仕様:
--   - 事業所ごとに登録 (= office_id FK)
--   - フィールド: name (= サービス内容) + detail (= 具体的取り組内容)
--   - 時間 (= 分) は登録しない (= 各 step 行で毎回手入力)
--   - 同事業所内で name 重複禁止 (= UNIQUE 制約)
--   - 既存手順書とは独立 (= テキスト一致での参照のみ、FK 無し)
--   - soft delete (= deleted_at) で履歴保持
--
-- 用途:
--   - 手順書編集 page で dropdown 候補として表示
--   - 専用管理画面 (/visit-procedures/templates) で CRUD
--
-- RLS:
--   - 他 visit_procedure_* table と同じ pattern (= authenticated 全許可)
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS kaigo_visit_procedure_step_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id   UUID NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  tenant_id   TEXT NOT NULL,
  name        TEXT NOT NULL,          -- "訪問・手洗・挨拶"
  detail      TEXT,                   -- "訪問。手洗い、うがいを済ませ..."
  sort_order  INTEGER NOT NULL DEFAULT 0,  -- 並び順 (= dropdown 表示順)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ,            -- soft delete
  UNIQUE (office_id, name)            -- 同事業所内で名前重複禁止
);

CREATE INDEX IF NOT EXISTS idx_kaigo_visit_procedure_step_templates_office
  ON kaigo_visit_procedure_step_templates(office_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_kaigo_visit_procedure_step_templates_tenant
  ON kaigo_visit_procedure_step_templates(tenant_id);

COMMENT ON TABLE kaigo_visit_procedure_step_templates IS
  '訪問介護手順書 step テンプレート (office ごと)。サービス内容 + 具体的取り組内容のセット。';

-- RLS
ALTER TABLE kaigo_visit_procedure_step_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kaigo_visit_procedure_step_templates_auth
  ON kaigo_visit_procedure_step_templates;
CREATE POLICY kaigo_visit_procedure_step_templates_auth
  ON kaigo_visit_procedure_step_templates FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- updated_at 自動更新 trigger
CREATE OR REPLACE FUNCTION trg_kaigo_vpst_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS kaigo_visit_procedure_step_templates_updated_at
  ON kaigo_visit_procedure_step_templates;
CREATE TRIGGER kaigo_visit_procedure_step_templates_updated_at
  BEFORE UPDATE ON kaigo_visit_procedure_step_templates
  FOR EACH ROW
  EXECUTE FUNCTION trg_kaigo_vpst_updated_at();

COMMIT;
