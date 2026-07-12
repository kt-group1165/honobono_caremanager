-- ============================================================================
-- 訪問介護・訪問入浴 高齢者虐待防止措置未実施減算 / 業務継続計画(BCP)未策定減算 の適用期間管理
-- ============================================================================
-- 2026-07-11。訪問介護 (介護 system / サービス種類 11) ・訪問入浴介護 (同 12) の
-- この 2 減算 (各 1%) は独立減算コードが無く、基本コードの合成バリエーション
-- (「身体７・虐防・Ⅰ」「訪問入浴・虐防・業未」等) で算定する。事業所単位の
-- 「未実施/未策定」フラグを適用期間付き (改善までの期間性) で持ち、集計
-- (src/lib/visit-seikyu/aggregate.ts / src/lib/bath-seikyu/aggregate.ts) が
-- 対象月でこのテーブルを引いて基本サービスコードを差し替える。テーブル未適用の
-- 環境は従来動作 (減算なし) にフォールバックする (42P01/PGRST205 handling 済)。
-- 構造は kaigo_office_addon_periods (適用加算の期間管理) と同型。

BEGIN;

CREATE TABLE IF NOT EXISTS kaigo_office_gensan_periods (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT NOT NULL DEFAULT 'kt-group',
  office_id    UUID NOT NULL,
  gensan_type  TEXT NOT NULL CHECK (gensan_type IN ('gyakutai', 'bcp')),
  start_month  TEXT,                 -- 'YYYY-MM' (NULL = 最初から)
  end_month    TEXT,                 -- 'YYYY-MM' (NULL = 無期限)
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE kaigo_office_gensan_periods IS
  '訪問介護・訪問入浴 体制未整備減算 (gyakutai=高齢者虐待防止措置未実施 / bcp=業務継続計画未策定) の事業所別適用期間';

CREATE INDEX IF NOT EXISTS idx_office_gensan_periods_office
  ON kaigo_office_gensan_periods (office_id, start_month);

ALTER TABLE kaigo_office_gensan_periods ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kaigo_office_gensan_periods_all ON kaigo_office_gensan_periods;
CREATE POLICY kaigo_office_gensan_periods_all ON kaigo_office_gensan_periods
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
