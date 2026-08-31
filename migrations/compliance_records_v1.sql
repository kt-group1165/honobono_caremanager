-- apps/kaigo-app/migrations/compliance_records_v1.sql
-- 2026-09-01 監査是正: 体制整備 (委員会・指針・研修・訓練) の記録が DB に無かった。
--
-- 【なぜ要るか】
--   令和6年度改定で義務づけられた体制整備のうち、
--     虐待防止      … 委員会 / 指針 / 研修 / 担当者     … 未実施は **1% 減算**
--     業務継続 (BCP)… 計画 / 研修 / 訓練               … 未策定は **1% 減算**
--     感染症対策    … 委員会 / 指針 / 研修 / 訓練
--     身体拘束等の適正化 … 記録 / 委員会 / 研修
--     ハラスメント対策
--   これらを裏づける記録の置き場が DB 220 テーブルのどこにも無かった (2026-08-31 監査)。
--
--   現状 kaigo_office_gensan_periods は 0 件 = 全 59 事業所が「減算なし」で請求している。
--   実地指導で体制未整備と判定されると **1% + 1% を遡って返還**になる。
--
--   さらに契約書兼重要事項説明書のテンプレ (juyo_06_gyakutai / juyo_06_bcp /
--   juyo_06_kansensho / juyo_06_kosoku) には
--     「委員会を設置し、指針を整備し、定期的に研修及び訓練を実施します」
--   と **利用者に約束する文面が入っている**。約束していて記録が無いのが一番まずい。
--
-- 【設計】
--   カテゴリ × 種別 の 1 テーブルに統合する。5 分野それぞれに表を作ると
--   画面も 5 つになり、結局どれも埋まらない。1 画面で全部見えるほうが埋まる。
--
--   ⚠ 必要な実施頻度 (年1回以上 等) はサービス種別・自治体で差があり、経過措置も
--     あったため、**DB では頻度を強制しない**。画面は「0 件」を警告するだけにし、
--     頻度の判断は人がする。誤った頻度をシステムが正としてしまうほうが危険。

BEGIN;

DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM user_groups ug
    JOIN auth.users u ON u.id = ug.user_id
   WHERE u.email = 'domen@kt-group.co.jp' AND ug.role = 'group_admin';
  IF v_count = 0 THEN
    RAISE EXCEPTION '安全弁失敗: group_admin domen が居ないので適用中止';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS kaigo_compliance_records (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL DEFAULT 'kt-group',
  office_id     UUID REFERENCES offices(id),

  -- 分野
  category      TEXT NOT NULL CHECK (category IN (
                  '虐待防止', '身体拘束適正化', '感染症対策', '業務継続(BCP)',
                  'ハラスメント対策', '事故防止', 'その他')),
  -- 種別
  kind          TEXT NOT NULL CHECK (kind IN ('委員会', '指針', '研修', '訓練', '担当者選任')),

  held_on       DATE NOT NULL,               -- 開催日 / 策定日 / 実施日
  title         TEXT,                        -- 議題・研修名・指針名
  attendees     TEXT,                        -- 出席者 (研修は受講者)
  attendee_count INT,
  leader_name   TEXT,                        -- 開催責任者 / 講師 / 担当者
  content       TEXT,                        -- 内容・議事の要点
  -- 指針・計画は「いつ版か」が問われる
  document_name TEXT,                        -- 指針/BCP の文書名
  revised_on    DATE,                        -- 指針/計画の改定日
  next_due_on   DATE,                        -- 次回予定 (年1回以上の管理用)

  notes         TEXT,
  extra         JSONB,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compliance_office_held
  ON kaigo_compliance_records (office_id, held_on DESC);
CREATE INDEX IF NOT EXISTS idx_compliance_category
  ON kaigo_compliance_records (office_id, category, kind, held_on DESC);

COMMENT ON TABLE kaigo_compliance_records IS
  '体制整備の記録 (委員会・指針・研修・訓練・担当者選任) を分野横断で 1 表に。'
  ' 虐待防止 / BCP の 1% 減算の立証、および実地指導での提出に使う。'
  ' 2026-09-01 監査是正で新設 (それまで DB に置き場が無かった)。';
COMMENT ON COLUMN kaigo_compliance_records.next_due_on IS
  '次回予定日。年1回以上の要件を切らさないための管理用。頻度は DB では強制しない'
  ' (サービス種別・自治体で差があり経過措置もあるため、判断は人がする)。';

-- RLS: tenant scope (USING(true) の全開にはしない)
ALTER TABLE kaigo_compliance_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kaigo_compliance_records_authenticated ON kaigo_compliance_records;
CREATE POLICY kaigo_compliance_records_authenticated ON kaigo_compliance_records
  FOR ALL TO authenticated
  USING      (tenant_id IN (SELECT auth_visible_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT auth_visible_tenant_ids()));

-- 監査ログ (体制整備の記録は後から作ったことにされると意味が無いので必須)
DO $$
BEGIN
  IF to_regprocedure('audit_row_change()') IS NULL THEN
    RAISE NOTICE '  − audit_row_change() が無いので監査トリガはスキップ';
    RETURN;
  END IF;
  DROP TRIGGER IF EXISTS trg_audit_kaigo_compliance_records ON kaigo_compliance_records;
  CREATE TRIGGER trg_audit_kaigo_compliance_records
    AFTER INSERT OR UPDATE OR DELETE ON kaigo_compliance_records
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();
  RAISE NOTICE '  ✓ 監査トリガ: kaigo_compliance_records';
END $$;

DO $$
DECLARE v_rls BOOLEAN; v_pol INT;
BEGIN
  SELECT c.relrowsecurity INTO v_rls FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relname='kaigo_compliance_records';
  SELECT COUNT(*) INTO v_pol FROM pg_policies
   WHERE schemaname='public' AND tablename='kaigo_compliance_records';
  IF NOT v_rls OR v_pol <> 1 THEN
    RAISE EXCEPTION '検証失敗: RLS=% / policy=% 件', v_rls, v_pol;
  END IF;
  RAISE NOTICE '✓ kaigo_compliance_records を新設しました (RLS tenant scope + 監査ログ)';
END $$;

COMMIT;

-- ロールバック: DROP TABLE IF EXISTS kaigo_compliance_records;
