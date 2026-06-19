-- =====================================================================
-- Phase Shougai-1: 障害福祉サービス対応 (= 介護 + 障害 統合)
-- =====================================================================
-- 背景:
--   ND ソフト「ほのぼの NEXT (= 介護保険)」と「ほのぼの more (= 障害福祉)」の
--   2 系統運用を統合する。方針: シフトは 1 元化、請求は 2 系統に分離。
--
-- 設計:
--   - clients.service_category: 'kaigo' / 'shougai' / 'both' (= 利用者の制度区分)
--   - events / kaigo_visit_* / kaigo_service_records.service_category:
--       'kaigo' / 'shougai' (= サービス記録 1 件単位のタグ)
--     → 請求 CSV 出力時にこのタグで介護分 / 障害分を分離する
--   - shougai_certifications: 障害支援区分の受給者証マスタ
--     (= 介護保険の認定区分 (kaigo_certifications 相当) に対応する障害版)
--
-- 後方互換:
--   既存データには service_category = 'kaigo' が DEFAULT で入る。
--   障害対応の record は UI 側で明示的に 'shougai' を選択する。
--
-- 適用方法:
--   Supabase SQL Editor で BEGIN-COMMIT 全文を 1 ブロックで Run。
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- A) 既存 table への service_category 列追加
-- ---------------------------------------------------------------------

-- A-1) clients (= 利用者マスタ): 'both' を許容 (= 介護も障害も両方利用)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS service_category TEXT NOT NULL DEFAULT 'kaigo'
  CHECK (service_category IN ('kaigo','shougai','both'));

COMMENT ON COLUMN clients.service_category IS '利用者の制度区分: kaigo=介護保険, shougai=障害福祉, both=両方';

-- A-2) events (= シフト/予定): NULL 許容 (= 介護でも障害でもない予定がありうる)
ALTER TABLE events ADD COLUMN IF NOT EXISTS service_category TEXT
  CHECK (service_category IS NULL OR service_category IN ('kaigo','shougai'));

COMMENT ON COLUMN events.service_category IS 'サービス記録の制度区分: kaigo=介護分, shougai=障害分。NULL=制度紐付け無し (会議等)';

-- A-3) kaigo_visit_records (= 訪問介護実施記録)
ALTER TABLE kaigo_visit_records ADD COLUMN IF NOT EXISTS service_category TEXT NOT NULL DEFAULT 'kaigo'
  CHECK (service_category IN ('kaigo','shougai'));

COMMENT ON COLUMN kaigo_visit_records.service_category IS '請求区分: kaigo=介護保険請求, shougai=障害福祉請求';

-- A-4) kaigo_visit_schedule (= 訪問予定)
ALTER TABLE kaigo_visit_schedule ADD COLUMN IF NOT EXISTS service_category TEXT NOT NULL DEFAULT 'kaigo'
  CHECK (service_category IN ('kaigo','shougai'));

COMMENT ON COLUMN kaigo_visit_schedule.service_category IS '請求区分: kaigo=介護保険, shougai=障害福祉';

-- A-5) kaigo_visit_patterns (= 定期訪問パターン)
ALTER TABLE kaigo_visit_patterns ADD COLUMN IF NOT EXISTS service_category TEXT NOT NULL DEFAULT 'kaigo'
  CHECK (service_category IN ('kaigo','shougai'));

COMMENT ON COLUMN kaigo_visit_patterns.service_category IS '請求区分: kaigo=介護保険, shougai=障害福祉';

-- A-6) kaigo_service_records (= サービス記録)
ALTER TABLE kaigo_service_records ADD COLUMN IF NOT EXISTS service_category TEXT NOT NULL DEFAULT 'kaigo'
  CHECK (service_category IN ('kaigo','shougai'));

COMMENT ON COLUMN kaigo_service_records.service_category IS '請求区分: kaigo=介護保険, shougai=障害福祉';

-- A-7) index (= 請求 CSV 出力時の絞り込み高速化)
CREATE INDEX IF NOT EXISTS idx_clients_service_category ON clients(service_category);
CREATE INDEX IF NOT EXISTS idx_visit_records_service_category ON kaigo_visit_records(service_category);

-- ---------------------------------------------------------------------
-- B) shougai_certifications (= 障害支援区分マスタ)
--    介護保険の認定区分 (要支援1〜要介護5) に相当する障害福祉版
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS shougai_certifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL DEFAULT 'kt-group',
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

  -- 障害支援区分 (区分1〜6 + 非該当)
  support_level TEXT NOT NULL
    CHECK (support_level IN ('区分1','区分2','区分3','区分4','区分5','区分6','非該当')),

  -- 主たる障害種別
  primary_disability TEXT
    CHECK (primary_disability IS NULL OR primary_disability IN (
      '身体障害','知的障害','精神障害','発達障害','難病','重複障害'
    )),

  -- 受給者証 (= 介護の被保険者証相当)
  certification_start_date DATE NOT NULL,
  certification_end_date   DATE NOT NULL,
  beneficiary_number       TEXT,          -- 受給者証番号
  insurer_municipality     TEXT,          -- 支給決定市町村

  -- 支給決定サービス (= 例: 居宅介護 / 重度訪問介護 / 行動援護 / 同行援護 / 短期入所 等)
  service_types            TEXT[] DEFAULT '{}',

  -- 自己負担割合 (= 0.1 = 1割。障害は所得に応じ上限月額あり)
  copay_rate               NUMERIC DEFAULT 0.1,

  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  shougai_certifications IS '障害福祉サービス受給者証 (= 障害支援区分マスタ)';
COMMENT ON COLUMN shougai_certifications.support_level IS '障害支援区分 (区分1〜6, または非該当)';
COMMENT ON COLUMN shougai_certifications.service_types IS '支給決定サービス種別の配列 (居宅介護 / 重度訪問介護 / 行動援護 / 同行援護 等)';
COMMENT ON COLUMN shougai_certifications.copay_rate IS '自己負担割合 (= 0.1 = 1割)';

CREATE INDEX IF NOT EXISTS idx_shougai_cert_client ON shougai_certifications(client_id);

-- RLS (= 既存 kaigo_* table と同じパターン: authenticated 全権)
ALTER TABLE shougai_certifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY shougai_cert_select ON shougai_certifications
  FOR SELECT TO authenticated USING (true);

CREATE POLICY shougai_cert_modify ON shougai_certifications
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;

-- =====================================================================
-- 適用後の確認 SQL (= 手動チェック用、本 file の COMMIT 範囲外)
-- =====================================================================
-- SELECT service_category, COUNT(*) FROM clients GROUP BY service_category;
-- SELECT service_category, COUNT(*) FROM kaigo_visit_records GROUP BY service_category;
-- SELECT COUNT(*) FROM shougai_certifications;
