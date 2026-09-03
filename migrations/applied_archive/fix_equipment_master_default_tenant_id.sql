-- ============================================================================
-- equipment_master / equipment_price_history の壊れた tenant_id='default' を是正する。
--
-- 背景 (2026-09-02 J 調査、offices.tenant_id是正の横展開調査で発覚):
--   equipment_master (order-appの用具マスタ) 総件数2,159件のうち 1,520件(70%)が
--   tenant_id='default' になっていた (正常な行は tenant_id='kt-group' の639件のみ)。
--   product_code の重複チェックでは kt-group 側の639件と1件も重複しておらず、
--   1,520件は完全に別の実在商品(TAISコード・価格付き、テストデータではない)。
--   created_at は全件 2026-03-27〜28 の2日間で、単発の一括取込と推測される。
--
--   同根で equipment_price_history にも 1,401件の tenant_id='default' 行があり、
--   全件が equipment_master(default側)の product_code と一致することを確認済み
--   (kt-group側とは1件も一致しない)。同じ取込イベントで発生した同型の問題。
--
--   実害: order-app の lib/equipment.ts の getEquipment(tenantId) が
--   .eq("tenant_id", tenantId) でフィルタしており、通常利用時 tenantId="kt-group"
--   のため、この1,520商品は2026-03-27頃から約5ヶ月間 order-app のどの画面からも
--   一切見えていなかった。
--
-- 対応: offices是正 (fix_hanamutsumi_placeholder_tenant_id.sql) と同じ形式。
--   tenant_id='default' の行を 'kt-group' に是正する。事前に product_code の
--   重複衝突が無いことを確認済みなので、UNIQUE制約違反等は起きない想定。
--
-- Supabase SQL Editor にそのまま貼って実行すること (BEGIN...COMMIT で1ブロック)。
-- ============================================================================

BEGIN;

-- 1) 更新前の該当行を backup (件数が多いため RLS 遮断を必ず行う。
--    feedback_backup_table_no_rls.md: CREATE TABLE AS は RLS を継承しないため、
--    遮断を忘れると anon から丸見えになる)
CREATE TABLE IF NOT EXISTS _backup_equipment_master_default_20260902 AS
SELECT * FROM equipment_master WHERE tenant_id = 'default';
ALTER TABLE _backup_equipment_master_default_20260902 ENABLE ROW LEVEL SECURITY;
ALTER TABLE _backup_equipment_master_default_20260902 FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS _backup_equipment_price_history_default_20260902 AS
SELECT * FROM equipment_price_history WHERE tenant_id = 'default';
ALTER TABLE _backup_equipment_price_history_default_20260902 ENABLE ROW LEVEL SECURITY;
ALTER TABLE _backup_equipment_price_history_default_20260902 FORCE ROW LEVEL SECURITY;

-- 2) 事前確認: product_code の衝突が無いことを再確認 (0件であること)
--    0件でなければ下の UPDATE を実行する前に手動確認すること
SELECT count(*) AS conflicting_product_codes
FROM equipment_master d
WHERE d.tenant_id = 'default'
  AND EXISTS (
    SELECT 1 FROM equipment_master k
    WHERE k.tenant_id = 'kt-group' AND k.product_code = d.product_code
  );

-- 3) 本体: tenant_id を是正 (安全弁として tenant_id='default' の行だけを対象にする)
UPDATE equipment_master
SET tenant_id = 'kt-group'
WHERE tenant_id = 'default';

UPDATE equipment_price_history
SET tenant_id = 'kt-group'
WHERE tenant_id = 'default';

-- 4) 確認: 是正後の件数
SELECT
  (SELECT count(*) FROM equipment_master WHERE tenant_id = 'default') AS equipment_master_remaining_default,
  (SELECT count(*) FROM equipment_master WHERE tenant_id = 'kt-group') AS equipment_master_kt_group_total,
  (SELECT count(*) FROM equipment_price_history WHERE tenant_id = 'default') AS price_history_remaining_default,
  (SELECT count(*) FROM equipment_price_history WHERE tenant_id = 'kt-group') AS price_history_kt_group_total;

COMMIT;

-- ============================================================================
-- 実行後、上記 SELECT で
--   equipment_master_remaining_default = 0
--   equipment_master_kt_group_total    = 2159 (639 + 1520)
--   price_history_remaining_default    = 0
-- になっていることを確認すること。
--
-- backup テーブル (_backup_equipment_master_default_20260902 /
-- _backup_equipment_price_history_default_20260902) は問題なければ後日 DROP して構わない。
--
-- ⚠ 別件 (未対応・規模小): equipment_price_history に tenant_id='care-chiba'
-- (Phase A2-extendedで物理削除済みの旧テナント) の残骸が1件ある。今回のSQLでは
-- 対象外 (tenant_id='default' のみを対象にしているため)。影響は極小だが、
-- 気になる場合は別途 `UPDATE equipment_price_history SET tenant_id='kt-group'
-- WHERE tenant_id='care-chiba';` で同様に是正できる。
-- ============================================================================
