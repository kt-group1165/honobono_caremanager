-- ============================================================================
-- kaigo_monthly_plan_units に office_id を持たせる (= 計画単位数は事業所ごとの値)
--
-- ── 何が壊れていたか ────────────────────────────────────────────────────
--   明細書 項9「計画単位数」は **その事業所に割り当てられた** 単位数。
--   1 人の利用者が複数事業所を使えば事業所ごとに別の値になる。
--   ところが本テーブルは UNIQUE(client_id, target_month) で事業所を持たず、
--   import_meisai_plan_units.mjs が onConflict="client_id,target_month" で
--   upsert していたため **後から取り込んだ事業所の値で上書き**されていた。
--
--   実証: 齋藤祥江 (ＫＴ姉崎 と 市原ムツミ の両方を利用)
--     K姉 6,100 単位 → 市原を取り込むと 1,952 に上書き
--     → K姉の明細書が 単位数合計 7,723 → 2,471、保険請求額 74,372 → 23,795 円に激減
--   6 月時点で K姉×市原 に 4 名。今後 拠点を増やすほど衝突は増える。
--
-- ── 移行 ──────────────────────────────────────────────────────────────
--   既存行は office_id NULL のまま残す (どの事業所の値か復元できないため)。
--   取込を回し直せば office_id 付きで入り直る。
--   NULL 行は「事業所不明の旧データ」として UNIQUE の対象外にする
--   (部分 UNIQUE INDEX)。
--
--   Supabase SQL Editor に貼って Run。COMMIT; まで含めてあります。
-- ============================================================================
BEGIN;

ALTER TABLE kaigo_monthly_plan_units
  ADD COLUMN IF NOT EXISTS office_id uuid REFERENCES offices(id) ON DELETE CASCADE;

-- 旧: client_id + target_month だけの UNIQUE を外す (制約名に依存せず探して落とす)
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'kaigo_monthly_plan_units'::regclass
      AND c.contype = 'u'
      AND (
        SELECT array_agg(a.attname::text ORDER BY a.attname::text)
        FROM unnest(c.conkey) k
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
      ) = ARRAY['client_id', 'target_month']
  LOOP
    EXECUTE format('ALTER TABLE kaigo_monthly_plan_units DROP CONSTRAINT %I', r.conname);
    RAISE NOTICE '旧 UNIQUE 制約を削除: %', r.conname;
  END LOOP;

  -- 制約ではなく素の UNIQUE INDEX で張られている場合も落とす
  FOR r IN
    SELECT i.indexrelid::regclass::text AS iname
    FROM pg_index i
    WHERE i.indrelid = 'kaigo_monthly_plan_units'::regclass
      AND i.indisunique
      AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)
      AND (
        SELECT array_agg(a.attname::text ORDER BY a.attname::text)
        FROM unnest(i.indkey) k
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k
      ) = ARRAY['client_id', 'target_month']
  LOOP
    EXECUTE format('DROP INDEX %s', r.iname);
    RAISE NOTICE '旧 UNIQUE INDEX を削除: %', r.iname;
  END LOOP;
END $$;

-- 新: 事業所ごとに 1 行。office_id NULL の旧行は対象外
CREATE UNIQUE INDEX IF NOT EXISTS kaigo_monthly_plan_units_client_month_office_key
  ON kaigo_monthly_plan_units (client_id, target_month, office_id)
  WHERE office_id IS NOT NULL;

-- 参照は (office, 月) 単位で引くので複合 index を張る
CREATE INDEX IF NOT EXISTS kaigo_monthly_plan_units_office_month_idx
  ON kaigo_monthly_plan_units (office_id, target_month);

COMMIT;
