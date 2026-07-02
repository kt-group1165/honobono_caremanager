-- ============================================================================
-- 訪問介護 手順書 モード切替 (先行スタート ↔ 通常)
-- ============================================================================
-- 経緯:
--   ソフト本体 (kaigo-app の clients マスタ) 完成前に手順書機能を先行運用したい
--   ため、手順書側で client 名を自入力できる standalone モードと、
--   本体 clients と連携する integrated モードを切替可能にする。
--
-- 設計:
--   * offices.visit_procedure_mode: 'standalone' | 'integrated' (default standalone)
--     - standalone: 手順書内で client_name (text) を管理
--     - integrated: kaigo_visit_procedure_documents.client_id → clients(id) 参照
--   * kaigo_visit_procedure_documents.client_id UUID NULL 列追加
--     - integrated 時に埋める。standalone 時は NULL のまま。
--     - client_name (既存 text) は両モードで残す (=表示に使う、integrated は
--       clients.name の snapshot として functional 冗長性)
-- ============================================================================

BEGIN;

-- 1) offices.visit_procedure_mode 列追加
ALTER TABLE offices
  ADD COLUMN IF NOT EXISTS visit_procedure_mode TEXT NOT NULL DEFAULT 'standalone'
  CHECK (visit_procedure_mode IN ('standalone', 'integrated'));

COMMENT ON COLUMN offices.visit_procedure_mode IS
  '手順書モード: standalone=手順書独自の利用者情報を使う (=先行スタート) / integrated=本体 clients と連携';

-- 2) kaigo_visit_procedure_documents.client_id 追加
ALTER TABLE kaigo_visit_procedure_documents
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_kaigo_visit_procedure_documents_client_id
  ON kaigo_visit_procedure_documents (client_id);

COMMENT ON COLUMN kaigo_visit_procedure_documents.client_id IS
  'integrated モード時に埋まる。standalone モードでは NULL のまま client_name (text) を使う';

COMMIT;
