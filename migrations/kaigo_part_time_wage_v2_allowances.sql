-- ============================================================================
-- パート給与 v2 — キャンセル手当・通信手当の設定
-- ============================================================================
-- 2026-07-16。第1弾 (時給×実働) に、キャンセル手当と通信手当を追加する。
-- payroll-app の計算に合わせる:
--   キャンセル手当 = キャンセル件数 × 事業所のキャンセル単価
--   通信手当       = 社保「未加入」者のみ。実働 50h超=1000円 / 0h超=500円 / 0h=0
--
--   kaigo_payroll_office_settings … 事業所別: キャンセル単価 (円/件)
--   kaigo_payroll_staff_settings  … 職員別: 社会保険 加入/未加入 (person 単位)
--
-- Supabase SQL Editor に貼って Run。冪等。v1 (kaigo_part_time_wage_v1.sql) 適用後に。
-- ============================================================================

BEGIN;

-- ── 事業所別 給与設定 (キャンセル単価 等) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS kaigo_payroll_office_settings (
  office_id UUID PRIMARY KEY REFERENCES offices(id) ON DELETE CASCADE,
  cancel_unit_price INTEGER NOT NULL DEFAULT 0,   -- キャンセル手当 単価 (円/件)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_kaigo_payroll_office_settings_updated_at ON kaigo_payroll_office_settings;
CREATE TRIGGER trg_kaigo_payroll_office_settings_updated_at
  BEFORE UPDATE ON kaigo_payroll_office_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE kaigo_payroll_office_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_all" ON kaigo_payroll_office_settings;
CREATE POLICY "authenticated_all" ON kaigo_payroll_office_settings
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── 職員別 給与設定 (社会保険 加入/未加入) ──────────────────────────────────
--   社保は person 単位なので member_id を主キーにする (通信手当は 未加入者のみ)。
CREATE TABLE IF NOT EXISTS kaigo_payroll_staff_settings (
  member_id UUID PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  social_insurance BOOLEAN NOT NULL DEFAULT false,  -- true=加入 (通信手当なし)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_kaigo_payroll_staff_settings_updated_at ON kaigo_payroll_staff_settings;
CREATE TRIGGER trg_kaigo_payroll_staff_settings_updated_at
  BEFORE UPDATE ON kaigo_payroll_staff_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE kaigo_payroll_staff_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_all" ON kaigo_payroll_staff_settings;
CREATE POLICY "authenticated_all" ON kaigo_payroll_staff_settings
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;

-- ロールバック:
-- DROP TABLE IF EXISTS kaigo_payroll_staff_settings;
-- DROP TABLE IF EXISTS kaigo_payroll_office_settings;
