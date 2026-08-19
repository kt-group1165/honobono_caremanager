-- ============================================================================
-- shogai_service_start — 障害の「サービス利用開始年月日」(伝送 J121-02 項8)
--
-- ── なぜ別に持つか ────────────────────────────────────────────────────
--   原典 (サービス事業所編 P.18) の定義:
--     「一連とみなされる利用契約の下で **最初にサービスを提供した日付** を記載する」
--   ⚠ 契約日でも当月の初回訪問日でもない。**契約支給量を変更しても動かない**。
--   実データ (四街道 6月/7月) で確認:
--     松戸孝雄  開始日 20250201 固定 / 契約日は 20260601 に変更されている
--     赤池晴子  開始日 20250501 固定 / 契約日は 20260601→20260701 と変わっている
--   → shogai_contracts.start_date からは導出できない。サービス種類ごとに 1 値を持つ。
--
--   実績から自動算出もできない (当システムには 2026-06 以降の実績しか無く、
--   2025-02 まで遡れない)。移行時は伝送から起こし、以後は
--   「契約が切れずに続く限り最初の提供日を保持」する運用にする。
--
--   キーは 利用者 × 事業所 × サービス種類コード (11=居宅介護 12=重度訪問 15=同行援護)。
--   一連の契約が切れて再契約したら更新する (そのとき初めて日付が動く)。
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS shogai_service_start (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'kt-group',
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  office_id uuid NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  service_type_code text NOT NULL CHECK (service_type_code ~ '^[0-9]{2}$'),
  start_date date NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, office_id, service_type_code)
);

COMMENT ON TABLE shogai_service_start IS
  '障害のサービス利用開始年月日 (伝送 J121-02 項8)。一連の契約下で最初に提供した日。契約支給量を変更しても動かない';

CREATE INDEX IF NOT EXISTS shogai_service_start_lookup
  ON shogai_service_start (office_id, client_id);

ALTER TABLE shogai_service_start ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shogai_service_start_rw ON shogai_service_start;
CREATE POLICY shogai_service_start_rw ON shogai_service_start
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
