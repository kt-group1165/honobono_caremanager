-- ============================================================================
-- office_sougou_numbers — 総合事業の事業所番号 (事業所 × 保険者)
--
-- ── なぜテーブルにするか ──────────────────────────────────────────────
--   総合事業は**市町村ごとの指定**なので、事業所番号は「事業所 × 保険者」で決まる。
--   1 事業所が複数市町村の総合事業を持ち、**一部の市町村だけ別番号**になる。
--     いすみ: 122184/124412 → 1278600398 (介護と同じ) / 122382 → 12A8600011 (別)
--     ちはら台: 122192 → 12A2400103 (別)
--   offices に 1 列 (sougou_business_number) では表現できない。
--   ほのぼのも保険者ごとに 71R1 ファイルを分けて出している。
--
--   ⚠ 英字を含む (12A2400103) ので数字 CHECK は付けない。
--   ここに無い保険者は offices.business_number (介護の番号) にフォールバックする。
--
--   出所: 各拠点の実伝送 KK の 71R1 基本情報 (項5=事業所番号 / 項6=保険者番号)
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS office_sougou_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'kt-group',
  office_id uuid NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  insurer_number text NOT NULL,          -- 証記載保険者番号 6 桁
  business_number text NOT NULL,         -- その保険者に対する総合事業の事業所番号 (10 桁・英字可)
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (office_id, insurer_number)
);

COMMENT ON TABLE office_sougou_numbers IS
  '総合事業の事業所番号 (事業所×保険者)。総合事業は市町村ごとの指定のため一部の市町村だけ別番号になる。無い保険者は offices.business_number を使う';

CREATE INDEX IF NOT EXISTS office_sougou_numbers_office_idx
  ON office_sougou_numbers (office_id, insurer_number);

ALTER TABLE office_sougou_numbers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS office_sougou_numbers_rw ON office_sougou_numbers;
CREATE POLICY office_sougou_numbers_rw ON office_sougou_numbers
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 実伝送で確認できた「介護と別番号」の 2 件だけ登録する
-- (同じ番号の保険者は行を作らない = フォールバックで足りる)
INSERT INTO office_sougou_numbers (office_id, insurer_number, business_number, notes)
VALUES
  ('fd0179ae-6a20-4bf2-9ab0-37d61c744f64', '122192', '12A2400103', 'ちはら台 実伝送 KK260804 で確認'),
  ('4015f747-4f75-4769-a1f2-dca3db6a24fc', '122382', '12A8600011', 'いすみ 実伝送 KK260805 で確認')
ON CONFLICT (office_id, insurer_number) DO UPDATE
  SET business_number = EXCLUDED.business_number, updated_at = now();

-- offices.sougou_business_number は上位互換の本テーブルに移したので使わない
COMMENT ON COLUMN offices.sougou_business_number IS
  '【非推奨】office_sougou_numbers (事業所×保険者) に移行。総合事業の番号は保険者ごとに決まるためこの列では表現できない';

COMMIT;
