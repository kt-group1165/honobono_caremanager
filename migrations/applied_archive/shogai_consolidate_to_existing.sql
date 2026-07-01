-- ============================================================================
-- shougai_certifications 新規作成 (+ 新列込) & 私の重複テーブル DROP
-- ============================================================================
-- 経緯:
--   /users/[id]/shougai-cert タブが既に UI として存在していたが、
--   基盤テーブル shougai_certifications は 未 apply の環境があった。
--   私 (LLM) は状況を誤認し shogai_recipient_certs / shogai_benefit_allocations を
--   新規作成する形で二重に実装してしまった。
--
-- このマイグレーションで:
--   1) shougai_certifications を IF NOT EXISTS で作成 (+ RLS + index)
--   2) 追加 5 列 (self_payment_limit / seiho_flag / soudan_* / monthly_allocations JSONB)
--   3) shogai_service_records.cert_id の FK を shougai_certifications に張替
--   4) 重複テーブル (shogai_recipient_certs / shogai_benefit_allocations) を DROP
--
-- 適用方法:
--   Supabase SQL Editor で BEGIN-COMMIT 1 ブロック Run
-- ============================================================================

BEGIN;

-- 1) shougai_certifications: 存在しなければ作成
CREATE TABLE IF NOT EXISTS shougai_certifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL DEFAULT 'kt-group',
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  support_level TEXT NOT NULL
    CHECK (support_level IN ('区分1','区分2','区分3','区分4','区分5','区分6','非該当')),
  primary_disability TEXT
    CHECK (primary_disability IS NULL OR primary_disability IN (
      '身体障害','知的障害','精神障害','発達障害','難病','重複障害'
    )),
  certification_start_date DATE NOT NULL,
  certification_end_date   DATE NOT NULL,
  beneficiary_number       TEXT,
  insurer_municipality     TEXT,
  service_types            TEXT[] DEFAULT '{}',
  copay_rate               NUMERIC DEFAULT 0.1,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shougai_cert_client ON shougai_certifications(client_id);

-- 2) 追加列 (idempotent)
ALTER TABLE shougai_certifications
  ADD COLUMN IF NOT EXISTS self_payment_limit INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS seiho_flag BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS soudan_office_name TEXT,
  ADD COLUMN IF NOT EXISTS soudan_manager_name TEXT,
  ADD COLUMN IF NOT EXISTS monthly_allocations JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 3) RLS
ALTER TABLE shougai_certifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shougai_cert_select ON shougai_certifications;
CREATE POLICY shougai_cert_select ON shougai_certifications
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS shougai_cert_modify ON shougai_certifications;
CREATE POLICY shougai_cert_modify ON shougai_certifications
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 4) shogai_service_records.cert_id の FK を shougai_certifications に張替
ALTER TABLE shogai_service_records
  DROP CONSTRAINT IF EXISTS shogai_service_records_cert_id_fkey;
ALTER TABLE shogai_service_records
  ADD CONSTRAINT shogai_service_records_cert_id_fkey
  FOREIGN KEY (cert_id) REFERENCES shougai_certifications(id) ON DELETE SET NULL;

-- 5) 重複テーブル DROP
DROP TABLE IF EXISTS shogai_benefit_allocations CASCADE;
DROP TABLE IF EXISTS shogai_recipient_certs CASCADE;

COMMIT;
