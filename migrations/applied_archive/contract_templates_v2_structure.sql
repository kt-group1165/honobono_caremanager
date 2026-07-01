-- ============================================================================
-- kaigo_contract_templates: parent_version_id + 構造化契約書サポート
-- ============================================================================
-- 変更内容:
--   1. parent_version_id UUID: 新版作成時に「どの版から派生したか」を記録
--        → diff view (v3 vs v2) の比較元として使う
--   2. content JSONB 内に .articles = ArticleNode[] の tree を追加していく
--        (schema 変更不要、JSONB のまま)
--        - Article: { id: uuid, chapeau, paragraphs: Paragraph[] }
--        - Paragraph: { id, chapeau, items: Item[] }
--        - Item: { id, marker: 'nakaguro'|'iroha'|'arabic', text }
--      条・項・号 の番号は render 時に index+1 から計算 (JSONB に埋めない)
-- ============================================================================

BEGIN;

ALTER TABLE kaigo_contract_templates
  ADD COLUMN IF NOT EXISTS parent_version_id UUID REFERENCES kaigo_contract_templates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_contract_templates_parent
  ON kaigo_contract_templates (parent_version_id);

COMMIT;
