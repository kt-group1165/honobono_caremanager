-- 訪問介護 手順書 v2 schema migration (2026-06-22 user 確定)
--
-- 変更点:
--   1. kaigo_visit_procedure_services から time_range 列削除 (= 週次表に統合)
--   2. kaigo_visit_procedure_documents.weekly_schedule の JSONB 構造変更
--      旧: { mon: { '1': {time_range, service_kind}, ... }, ... }
--      新: { mon: [ {'1': {start: 'HH:MM'}, '2': {start}, ...}, ...rows ], ... }
--      ※ 構造変更だけで列名は同じ。コメントだけ更新
--   3. app_settings global テーブル新規作成 (key/value JSONB)
--      step 所要時間プルダウン上限などのアプリ横断 setting を保存
--
-- 既存データは破棄して新規入力前提 (= memory: project_visit_procedures_v2_spec.md §5)
--
-- ❗ Supabase SQL Editor で実行する場合の事前確認 (README):
--   -- app_settings table 既存チェック (= 別 app で先に作っていないか):
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'public' AND table_name = 'app_settings';
--   -- 列構成も確認:
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'app_settings';
--
-- ※ CREATE TABLE IF NOT EXISTS なので 既存があれば skip される。
--    ただし既存の列構成が想定 (key TEXT PRIMARY KEY / value JSONB / updated_at) と
--    違う場合は手動調整が必要。実行前に上記 SELECT を確認。

BEGIN;

-- 1. services から time_range 削除 (= 週次表に移動)
ALTER TABLE kaigo_visit_procedure_services
  DROP COLUMN IF EXISTS time_range;

-- 2. weekly_schedule の構造変更コメント更新
COMMENT ON COLUMN kaigo_visit_procedure_documents.weekly_schedule IS
  '週次表 JSONB v2: { mon: [ { "1": { "start": "09:00" }, "2": null, ... }, ... ], tue: [...], ... }';

-- 3. 既存 weekly_schedule を初期化 (= 旧構造を残すと UI が壊れるため)
UPDATE kaigo_visit_procedure_documents
   SET weekly_schedule = '{}'::jsonb
 WHERE weekly_schedule IS NOT NULL;

-- 4. app_settings global table (= 既存があれば skip)
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS app_settings_auth ON app_settings;
CREATE POLICY app_settings_auth ON app_settings FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 5. default 値 INSERT (= step 所要時間プルダウン上限 = 60 分)
INSERT INTO app_settings (key, value)
VALUES ('visit_procedure_step_duration_max', '60'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 6. updated_at trigger (= app_settings 用)
CREATE OR REPLACE FUNCTION trg_app_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_settings_updated_at ON app_settings;
CREATE TRIGGER app_settings_updated_at
  BEFORE UPDATE ON app_settings
  FOR EACH ROW
  EXECUTE FUNCTION trg_app_settings_updated_at();

COMMIT;
