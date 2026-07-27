-- ============================================================================
-- 事業所の追加指定サービス (案②: 1マスタが複数サービス種類の指定を持つ)
--
-- 背景: 同じ物理的事業所が 居宅介護支援(43) と 介護予防支援(46) の両方の指定を
-- 持つ場合、事業所番号が別 (令和6年3月まで予防は地域包括委託で別番号、令和6年4月
-- 以降は自前指定で46の番号)。ほのぼのは「予防○○事業所」と別レコードにしていたが、
-- 本システムは 1 事業所マスタのまま、追加指定をこのサブテーブルにぶら下げる。
--
--   offices.business_number         = 主たる指定の番号 (通常 43 / 事業所の service_type)
--   office_service_designations     = 追加指定 (46 介護予防支援 等) の番号・加算
--
-- 請求/伝送は「利用者の要介護/要支援 → サービス種類コード(43/46) → 該当番号」で引く。
-- (billing 側の category 分岐は別コミットで対応。本表は器のみ)
--
-- Supabase SQL Editor に貼って Run。冪等 (IF NOT EXISTS)。
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS office_service_designations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id UUID NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  -- サービス種類コード (kaigo_service_codes.service_category と同体系。'46'=介護予防支援 等)
  service_category TEXT NOT NULL,
  service_category_name TEXT,
  -- 10桁事業所番号。委託先(地域包括)の番号でも自前指定の番号でも可
  business_number TEXT,
  -- この指定で取得している加算 (offices.applied_formula_codes と同形式)
  applied_formula_codes TEXT[] NOT NULL DEFAULT '{}',
  -- '指定' (自前指定) / '委託' (地域包括からの委託) — 表示・区別用
  designation_type TEXT NOT NULL DEFAULT '指定' CHECK (designation_type IN ('指定', '委託')),
  designated_from DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 1事業所 × 1サービス種類 は1行
  UNIQUE (office_id, service_category)
);

CREATE INDEX IF NOT EXISTS idx_office_designations_office
  ON office_service_designations (office_id);

DROP TRIGGER IF EXISTS trg_office_designations_updated_at ON office_service_designations;
CREATE TRIGGER trg_office_designations_updated_at
  BEFORE UPDATE ON office_service_designations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE office_service_designations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_all" ON office_service_designations;
CREATE POLICY "authenticated_all" ON office_service_designations
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;

-- 確認:
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_name = 'office_service_designations' ORDER BY ordinal_position;
--
-- ロールバック:
-- DROP TABLE IF EXISTS office_service_designations;
