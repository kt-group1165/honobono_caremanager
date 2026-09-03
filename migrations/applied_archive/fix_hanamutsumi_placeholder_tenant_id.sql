-- ============================================================================
-- offices 3件の壊れた tenant_id を是正する。
--
-- 背景 (2026-09-02 J 調査):
--   order-app の 3 事業所 (千葉(上り) / 市原･袖ケ浦･木更津(下り) / その他、
--   いずれも service_type='福祉用具', app_type='order-app') の tenant_id が
--   文字どおり "<Hanaムツミのtenant_id>" という未置換のプレースホルダ文字列の
--   まま入っていた (created_at は3件とも 2026-04-19T13:20:33 で単発SQL実行と推測)。
--
--   apps/kaigo-app/migrations/_backup_a2_export_20260831/tenants_backup_a2_20260507.json
--   (Phase 8 統合前の旧 tenants テーブルバックアップ) に
--   id="hana-mutsumi", name="Hanaムツミ福祉用具" という実在レコードがあり、
--   本来この値が入るべきだったと推測される。
--
--   実害: order-app の lib/offices.ts の getOffices(tenantId) が
--   .eq("tenant_id", tenantId) でフィルタしており、通常利用時 tenantId="kt-group"
--   のためこの3件は作成以来 (約4.5ヶ月) order-app のどの画面からも見えていなかった。
--   Phase 8 (office-tenant 統合) は「実在する tenant_id のリスト」に対して処理した
--   ため、実在しない壊れた値はマッチせず、この3件だけ移行から取り残された。
--
-- 対応: 他の全事業所と同じく tenant_id を 'kt-group' に是正する
--   (Phase 8 で全社が kt-group に統合済みのため、当時の "hana-mutsumi" ではなく
--   現行の 'kt-group' に合わせるのが正しい)。
--
-- Supabase SQL Editor にそのまま貼って実行すること (BEGIN...COMMIT で1ブロック)。
-- ============================================================================

BEGIN;

-- 1) 更新前の該当3件だけを backup (念のため。件数が少ないので全カラムそのまま複製)
CREATE TABLE IF NOT EXISTS _backup_offices_hanamutsumi_tenantid_20260902 AS
SELECT * FROM offices
WHERE id IN (
  '4771e718-4fca-4fde-bd80-cac0d54b689b',  -- 千葉(上り)
  '8fc6000b-4917-42e3-9bee-e5da2dafb592',  -- 市原･袖ケ浦･木更津(下り)
  '4702a99d-bcf9-49b2-be6b-fdc8edabf742'   -- その他
);

-- 2) 本体: tenant_id を是正
UPDATE offices
SET tenant_id = 'kt-group'
WHERE id IN (
  '4771e718-4fca-4fde-bd80-cac0d54b689b',
  '8fc6000b-4917-42e3-9bee-e5da2dafb592',
  '4702a99d-bcf9-49b2-be6b-fdc8edabf742'
)
AND tenant_id = '<Hanaムツミのtenant_id>';  -- 想定外の値を上書きしないよう安全弁

-- 3) 確認: 3件とも tenant_id='kt-group' になっているか
SELECT id, name, tenant_id, service_type, app_type
FROM offices
WHERE id IN (
  '4771e718-4fca-4fde-bd80-cac0d54b689b',
  '8fc6000b-4917-42e3-9bee-e5da2dafb592',
  '4702a99d-bcf9-49b2-be6b-fdc8edabf742'
)
ORDER BY sort_order;

COMMIT;

-- ============================================================================
-- 実行後、上記 SELECT の結果で 3 件とも tenant_id = 'kt-group' になっていることを
-- 目視確認すること。backup テーブル (_backup_offices_hanamutsumi_tenantid_20260902)
-- は問題なければ後日 DROP して構わない。
-- ============================================================================
