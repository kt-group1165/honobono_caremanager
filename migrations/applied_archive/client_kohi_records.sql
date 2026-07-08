-- ═══════════════════════════════════════════════════════════════════════════
-- 公費 (生活保護等) の独立管理テーブル — ほのぼのNEXT互換の別管理化
--
-- 背景:
--   従来は client_insurance_records の kohi_* 5 列 (1 利用者の最新認定に 1 組) で
--   管理していたが、ほのぼの側が公費を別マスタで管理しているため、移行しやすさを
--   優先して独立テーブル化する (複数公費・期間履歴・給付順位・本人支払額に対応)。
--
-- 適用: Supabase SQL Editor に全文貼り付けて Run (BEGIN〜COMMIT の 1 ブロック)
-- 注意: 旧列 (client_insurance_records.kohi_*) はまだ DROP しない (検証後に別途)。
--       アプリ側は client_kohi_records 未作成時に旧列へフォールバックする。
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS client_kohi_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL DEFAULT 'kt-group',
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- 法別番号 (12=生活保護, 25=中国残留邦人, 10=感染症(結核), 21=精神通院, 54=難病, 19=被爆者 等)
  kohi_hobetsu TEXT NOT NULL,
  -- 公費負担者番号 (8桁)
  futansha_number TEXT,
  -- 公費受給者番号 (7桁)
  jukyusha_number TEXT,
  -- 適用開始 (介護券の有効期間)
  start_date DATE,
  -- 適用終了 (NULL = 継続)
  end_date DATE,
  -- 給付順位 (複数公費の適用順。小さいほど優先)
  priority INT NOT NULL DEFAULT 1,
  -- 本人支払額/月 (介護券記載。0 = なし)
  honnin_futan INT NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_kohi_records_client_start
  ON client_kohi_records (client_id, start_date);

ALTER TABLE client_kohi_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_kohi_records_authenticated_all ON client_kohi_records;
CREATE POLICY client_kohi_records_authenticated_all
  ON client_kohi_records
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ── 既存データ移行 ──────────────────────────────────────────────────────────
-- client_insurance_records の kohi_hobetsu IS NOT NULL 行から、
-- effective_date 降順の最新 1 件/利用者を移行する (旧列は残す)。
-- 再実行安全: 既に移行済みの client は除外 (NOT EXISTS)。
INSERT INTO client_kohi_records
  (tenant_id, client_id, kohi_hobetsu, futansha_number, jukyusha_number, start_date, end_date, notes)
SELECT DISTINCT ON (cir.client_id)
  COALESCE(cir.tenant_id, 'kt-group'),
  cir.client_id,
  cir.kohi_hobetsu,
  cir.kohi_futansha_number,
  cir.kohi_jukyusha_number,
  cir.kohi_start_date,
  cir.kohi_end_date,
  '[migrated from client_insurance_records 2026-07-08]'
FROM client_insurance_records cir
WHERE cir.kohi_hobetsu IS NOT NULL
  AND btrim(cir.kohi_hobetsu) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM client_kohi_records k WHERE k.client_id = cir.client_id
  )
ORDER BY cir.client_id, cir.effective_date DESC NULLS LAST;

COMMIT;

-- 適用後の確認 (件数が移行対象と一致するか):
--   SELECT count(*) FROM client_kohi_records;
--   SELECT c.name, k.kohi_hobetsu, k.futansha_number, k.jukyusha_number, k.start_date, k.end_date
--   FROM client_kohi_records k JOIN clients c ON c.id = k.client_id;
