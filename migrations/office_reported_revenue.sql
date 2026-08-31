-- ============================================================================
-- 事業所の売上報告書 (Excel) から **そのまま写した**売上を持つ表
--
-- ── なぜ別表にするか ────────────────────────────────────────────────────
--   当システムが実績から計算できるのは **要介護のケアプラン分 (居宅介護支援費)** だけ。
--
--     予防プラン (介護予防支援)  地域包括からの委託。国保連を通らず包括から直接
--                                支払われるので、当システムには請求データが無い
--     その他収入                  文書料・自費サービス等。請求システムに乗らない
--
--   これらは事業所が Excel の報告書で出している数字をそのまま入れる。
--
-- ⚠ **システムが実績から計算した値ではない**。人が入力した報告書の写しである。
--   同じ表に混ぜると区別がつかなくなるので別表にし、必ず出典を持たせる。
--   画面・集計では「報告書より」と分かるように出すこと。
--
--   いずれ予防支援の実績も当システムで持つようになったら、この表は
--   突合の相手 (報告書 vs システム) に役割が変わる。消さずに残す。
--
-- 実行: Supabase SQL Editor に貼って Run
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS kaigo_office_reported_revenue (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  office_id     uuid NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  -- 提供年月 (YYYY-MM)。報告書の列は提供年月である (介護プラン総額で 1 円一致して確認済み)
  month         text NOT NULL,
  -- 何の売上か。当システムで計算できないものだけを入れる
  category      text NOT NULL,
  amount        integer NOT NULL,
  -- 件数 (報告書にある場合)
  count         integer,
  -- ⚠ 出典。**これがある行はシステムの計算値ではない**
  source        text NOT NULL DEFAULT '事業所報告書(Excel)',
  source_file   text,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT kaigo_office_reported_revenue_category_check
    CHECK (category IN ('予防プラン', '予防プラン月遅れ', 'その他収入')),
  CONSTRAINT kaigo_office_reported_revenue_month_check
    CHECK (month ~ '^\d{4}-\d{2}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS kaigo_office_reported_revenue_key
  ON kaigo_office_reported_revenue (office_id, month, category);

CREATE INDEX IF NOT EXISTS idx_office_reported_revenue_month
  ON kaigo_office_reported_revenue (tenant_id, month);

COMMENT ON TABLE kaigo_office_reported_revenue IS
  '事業所の売上報告書 (Excel) から写した売上。⚠ システムが実績から計算した値ではない。'
  '当システムで請求データを持たないもの (予防プラン・その他収入) だけを入れる';
COMMENT ON COLUMN kaigo_office_reported_revenue.source IS
  '出典。この列がある = 人が作った報告書の写しであってシステムの計算値ではない';
COMMENT ON COLUMN kaigo_office_reported_revenue.category IS
  '予防プラン = 介護予防支援 (包括からの委託。国保連を通らない) / その他収入 = 文書料等';

ALTER TABLE kaigo_office_reported_revenue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kaigo_office_reported_revenue_rw ON kaigo_office_reported_revenue;
CREATE POLICY kaigo_office_reported_revenue_rw ON kaigo_office_reported_revenue
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
