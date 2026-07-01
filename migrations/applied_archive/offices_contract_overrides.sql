-- ============================================================================
-- offices.contract_overrides
--  = 事業所ごとに契約書テンプレの任意 key を上書き
--    (別紙7 苦情窓口 / 別紙1 相談窓口 / 職員体制 / 交通費 等、事業所固有の値)
-- ----------------------------------------------------------------------------
-- render 側の fallback 順:
--   contract.content[key] (=snapshot)
--   → office.contract_overrides[key]  ← このカラム
--   → active_template.content[key]
--   → defaults (types.ts)
-- ============================================================================

BEGIN;

ALTER TABLE offices
  ADD COLUMN IF NOT EXISTS contract_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
