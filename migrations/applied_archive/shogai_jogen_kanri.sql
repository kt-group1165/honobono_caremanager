-- ============================================================================
-- 障害福祉: 利用者負担上限額管理 + 契約支給量 (2026-07-03)
-- ============================================================================
-- ほのぼのmore 請求手順動画 (上限管理事業所の登録 自/他) に対応する Phase 1。
--   1) 受給者証に上限額管理事業所の情報 (区分/事業所番号/名称) を追加
--   2) 受給者証の事業者記入欄 (契約支給量・契約開始日・記入欄番号) を追加
--   3) 月次の上限額管理結果 (管理結果区分 1/2/3 + 調整後負担額) テーブルを新設
--      → 障害請求の利用者負担額に反映する

BEGIN;

-- 1) + 2) 受給者証への列追加
ALTER TABLE shougai_certifications
  ADD COLUMN IF NOT EXISTS jogen_kanri_kubun TEXT NOT NULL DEFAULT 'なし'
    CHECK (jogen_kanri_kubun IN ('なし', '自事業所', '他事業所')),
  ADD COLUMN IF NOT EXISTS jogen_kanri_office_number TEXT,
  ADD COLUMN IF NOT EXISTS jogen_kanri_office_name TEXT,
  ADD COLUMN IF NOT EXISTS contract_amount_text TEXT,
  ADD COLUMN IF NOT EXISTS contract_start_date DATE,
  ADD COLUMN IF NOT EXISTS contract_entry_number TEXT;

COMMENT ON COLUMN shougai_certifications.jogen_kanri_kubun IS '利用者負担上限額管理: なし / 自事業所 (当事業所が管理者) / 他事業所';
COMMENT ON COLUMN shougai_certifications.jogen_kanri_office_number IS '上限額管理事業所の事業所番号 (10桁)';
COMMENT ON COLUMN shougai_certifications.jogen_kanri_office_name IS '上限額管理事業所名';
COMMENT ON COLUMN shougai_certifications.contract_amount_text IS '契約支給量 (受給者証 事業者記入欄の表記。例: 身体介護 10時間/月)';
COMMENT ON COLUMN shougai_certifications.contract_start_date IS '契約開始日 (事業者記入欄)';
COMMENT ON COLUMN shougai_certifications.contract_entry_number IS '受給者証 事業者記入欄番号';

-- 3) 月次 上限額管理結果
CREATE TABLE IF NOT EXISTS shogai_jogen_kanri_results (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            TEXT NOT NULL DEFAULT 'kt-group',
  client_id            UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  target_month         TEXT NOT NULL,   -- 'YYYY-MM'
  -- 管理結果区分:
  --   1 = 管理事業所で利用者負担額を充当したため、他事業所の利用者負担は発生しない
  --   2 = 利用者負担額の合算額が負担上限月額以下のため、調整事務は行わない
  --   3 = 合算額が負担上限月額を超過するため、管理結果票のとおり調整した
  kanri_result         INT CHECK (kanri_result IN (1, 2, 3)),
  -- 管理結果後の当事業所分 利用者負担額 (区分 1/3 のとき請求に反映)
  kanri_result_amount  INT,
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, target_month)
);

ALTER TABLE shogai_jogen_kanri_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shogai_jogen_kanri_results_all ON shogai_jogen_kanri_results;
CREATE POLICY shogai_jogen_kanri_results_all ON shogai_jogen_kanri_results
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
