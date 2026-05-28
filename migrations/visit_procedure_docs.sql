-- 訪問介護 手順書/モジュール 機能 Phase 1
-- 3 table: documents (本体) / services (1 doc に 1-5) / steps (1 service に N)
-- 利用者DB 未連携 (client_name 自由入力)
-- ※ apply は user 任せ。Supabase SQL Editor では BEGIN/COMMIT を外して実行する場合もあるので注意

BEGIN;

-- 1. 手順書 本体
CREATE TABLE IF NOT EXISTS kaigo_visit_procedure_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  office_id UUID,                          -- 訪問介護事業所 (NULL 可)
  client_name TEXT NOT NULL,               -- 自由入力 (利用者DB 未連携)
  plan_start_date DATE NOT NULL,
  author_name TEXT,                        -- サービス提供責任者
  creation_reason TEXT,                    -- 短期目標更新の為 / 初回 / etc.
  special_notes TEXT,                      -- 全体特記事項
  -- 週次表: { mon: { '1': '8:50-9:20', '2': '...'}, tue: {}, ... } を JSONB で
  weekly_schedule JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID                          -- auth.users.id
);
CREATE INDEX IF NOT EXISTS idx_visit_proc_docs_tenant ON kaigo_visit_procedure_documents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_visit_proc_docs_client_name ON kaigo_visit_procedure_documents(client_name);

COMMENT ON TABLE kaigo_visit_procedure_documents IS '訪問介護 手順書 本体 (Excel ④手順 sheet 相当)';
COMMENT ON COLUMN kaigo_visit_procedure_documents.client_name IS '利用者氏名 (Phase 1 は自由入力、利用者DB 未連携)';
COMMENT ON COLUMN kaigo_visit_procedure_documents.weekly_schedule IS '週次表 JSONB: { mon: { "1": "8:50-9:20", "2": ... }, tue: {}, ... }';

-- 2. サービス (1 doc に 1〜5)
CREATE TABLE IF NOT EXISTS kaigo_visit_procedure_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES kaigo_visit_procedure_documents(id) ON DELETE CASCADE,
  service_no INTEGER NOT NULL CHECK (service_no BETWEEN 1 AND 5),
  time_range TEXT,                         -- "8:50-9:20"
  service_kind TEXT NOT NULL,              -- '身体1' | '身体2' | '身体3' | '生活2' | '生活3' | '身体1生活1' | ... (11 enum)
  special_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, service_no)
);

COMMENT ON TABLE kaigo_visit_procedure_services IS '訪問介護 手順書サービス (Excel ④ のサービス①〜⑤)';

-- 3. ステップ (1 service に N step)
CREATE TABLE IF NOT EXISTS kaigo_visit_procedure_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES kaigo_visit_procedure_services(id) ON DELETE CASCADE,
  step_no INTEGER NOT NULL,
  content TEXT NOT NULL,                    -- "訪問・手洗・挨拶" 等
  minutes INTEGER NOT NULL DEFAULT 5,       -- 所要時間 (5min 単位推奨だが任意整数 OK)
  detail TEXT,                              -- "具体的取り組内容及び手順"
  UNIQUE (service_id, step_no)
);

COMMENT ON TABLE kaigo_visit_procedure_steps IS '訪問介護 手順書ステップ (Excel ④ の "サービス内容 + 時間 + 具体的取り組内容及び手順" 行)';

ALTER TABLE kaigo_visit_procedure_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_visit_procedure_services  ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaigo_visit_procedure_steps     ENABLE ROW LEVEL SECURITY;

-- RLS: authenticated は同 tenant の row のみ操作可 (Phase 1 は tenant filter は app 側で担保)
DROP POLICY IF EXISTS visit_proc_docs_auth ON kaigo_visit_procedure_documents;
DROP POLICY IF EXISTS visit_proc_services_auth ON kaigo_visit_procedure_services;
DROP POLICY IF EXISTS visit_proc_steps_auth ON kaigo_visit_procedure_steps;

CREATE POLICY visit_proc_docs_auth ON kaigo_visit_procedure_documents FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY visit_proc_services_auth ON kaigo_visit_procedure_services FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY visit_proc_steps_auth ON kaigo_visit_procedure_steps FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- updated_at trigger
CREATE OR REPLACE FUNCTION trg_visit_proc_docs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS visit_proc_docs_updated_at ON kaigo_visit_procedure_documents;
CREATE TRIGGER visit_proc_docs_updated_at
  BEFORE UPDATE ON kaigo_visit_procedure_documents
  FOR EACH ROW
  EXECUTE FUNCTION trg_visit_proc_docs_updated_at();

COMMIT;
