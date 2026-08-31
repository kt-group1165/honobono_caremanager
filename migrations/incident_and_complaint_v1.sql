-- apps/kaigo-app/migrations/incident_and_complaint_v1.sql
-- 2026-09-01 監査是正: 事故報告書と苦情受付簿の置き場が DB に存在しなかった。
--
-- 【なぜ要るか】
--   運営基準で作成・保存が義務づけられているのに、DB 220 テーブルを全部見ても
--   該当するものが 1 つも無かった (2026-08-31 監査)。実地指導では必ず
--   「事故報告書の綴り」「苦情受付簿」の提出を求められる。
--
--   しかも契約書兼重要事項説明書のテンプレには
--     juyo_06_incident … 事故発生時の対応
--     苦情対応窓口を設置し迅速に対応します
--   と **利用者に約束する文面が入っている**。約束していて記録が無い状態は
--   指導時にいちばん突かれる形になる。
--
-- 【設計】
--   ・どちらも「事業所単位の台帳」。利用者に紐づかない事故 (職員の負傷、物損) や
--     利用者が特定できない苦情もあるので client_id は NULL 可。
--   ・RLS は tenant scope。`USING (true)` の全開にはしない (2026-09-01 の規律)。
--   ・監査ログ (audit_log) のトリガを最初から張る。記録の改ざん防止は
--     この 2 表こそ必要 (事故報告は後から書き換えると重大な問題になる)。
--   ・様式は自治体ごとに違うが、共通して聞かれる項目を列にした。
--     自治体固有の欄は notes / extra (JSONB) で吸収する。

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

-- ============================================================================
-- 1) 事故報告書
-- ============================================================================
CREATE TABLE IF NOT EXISTS kaigo_incident_reports (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               TEXT NOT NULL DEFAULT 'kt-group',
  office_id               UUID REFERENCES offices(id),
  -- 利用者が特定できない事故 (職員の負傷・物損・第三者) もあるので NULL 可
  client_id               UUID REFERENCES clients(id) ON DELETE SET NULL,

  -- 発生
  occurred_at             TIMESTAMPTZ NOT NULL,
  occurred_place          TEXT,                       -- 利用者宅 / 浴室 / 移動中 等
  incident_type           TEXT,                       -- 転倒 / 転落 / 誤薬 / 誤嚥 / 紛失・破損 / 感染症 / その他
  discoverer_name         TEXT,                       -- 発見者
  description             TEXT,                       -- 発生状況 (5W1H)

  -- 傷害・受診
  injury_level            TEXT,                       -- なし / 軽傷 / 通院 / 入院 / 死亡
  medical_visited         BOOLEAN NOT NULL DEFAULT false,
  medical_institution     TEXT,
  diagnosis               TEXT,

  -- 連絡・報告 (ここが空だと運営指導で必ず指摘される)
  family_notified_at      TIMESTAMPTZ,
  family_notified_to      TEXT,                       -- 連絡した相手 (続柄)
  municipality_reported_at DATE,                      -- 市町村へ報告した日
  municipality_name       TEXT,
  insurer_reported_at     DATE,                       -- 保険者へ報告した日

  -- 対応・分析
  immediate_action        TEXT,                       -- 事故発生時の対応
  cause_analysis          TEXT,                       -- 原因分析
  prevention              TEXT,                       -- 再発防止策
  compensation            TEXT,                       -- 損害賠償の有無・内容

  reporter_name           TEXT,                       -- 記入者
  status                  TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  notes                   TEXT,
  extra                   JSONB,                      -- 自治体固有の欄
  created_by              UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_incident_office_occurred
  ON kaigo_incident_reports (office_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_incident_client
  ON kaigo_incident_reports (client_id, occurred_at DESC);

COMMENT ON TABLE kaigo_incident_reports IS
  '事故報告書。運営基準で作成・保存が義務。実地指導で必ず提出を求められる。'
  ' 2026-09-01 監査是正で新設 (それまで DB に置き場が無かった)。';
COMMENT ON COLUMN kaigo_incident_reports.municipality_reported_at IS
  '市町村へ事故報告した日。空欄のまま放置すると運営指導で指摘される。';

-- ============================================================================
-- 2) 苦情受付簿
-- ============================================================================
CREATE TABLE IF NOT EXISTS kaigo_complaints (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               TEXT NOT NULL DEFAULT 'kt-group',
  office_id               UUID REFERENCES offices(id),
  client_id               UUID REFERENCES clients(id) ON DELETE SET NULL,

  -- 受付
  received_at             TIMESTAMPTZ NOT NULL,
  received_via            TEXT,                       -- 電話 / 来所 / 訪問 / 書面 / メール / 第三者委員 / 行政 / 国保連
  receiver_name           TEXT,                       -- 受付者
  complainant_name        TEXT,                       -- 申出人
  complainant_relation    TEXT,                       -- 本人 / 家族 / 近隣 / 他事業所 / その他
  content                 TEXT,                       -- 苦情の内容

  -- 対応
  responder_name          TEXT,
  response                TEXT,                       -- 対応内容
  responded_at            TIMESTAMPTZ,
  resolved_at             DATE,
  result                  TEXT,                       -- 解決 / 継続中 / 他機関へ移管 / 取り下げ
  prevention              TEXT,                       -- 再発防止策

  -- 外部への報告 (国保連・行政経由の苦情は報告義務がある)
  reported_to             TEXT,                       -- 市町村 / 国保連 / 都道府県 等
  reported_at             DATE,

  status                  TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  notes                   TEXT,
  extra                   JSONB,
  created_by              UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_complaint_office_received
  ON kaigo_complaints (office_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_complaint_client
  ON kaigo_complaints (client_id, received_at DESC);

COMMENT ON TABLE kaigo_complaints IS
  '苦情受付簿。受付・対応・結果の記録が運営基準で義務。'
  ' 契約書に「苦情対応窓口を設置し迅速に対応します」と記載しているのに'
  ' 受付簿が無い状態だったため 2026-09-01 監査是正で新設。';

-- ============================================================================
-- 3) RLS (tenant scope。USING(true) の全開にはしない)
-- ============================================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['kaigo_incident_reports', 'kaigo_complaints'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_authenticated', t);
    EXECUTE format($f$
      CREATE POLICY %I ON public.%I FOR ALL TO authenticated
        USING      (tenant_id IN (SELECT auth_visible_tenant_ids()))
        WITH CHECK (tenant_id IN (SELECT auth_visible_tenant_ids()))
    $f$, t || '_authenticated', t);
    RAISE NOTICE '  ✓ RLS (tenant scope): %', t;
  END LOOP;
END $$;

-- ============================================================================
-- 4) 監査ログ (audit_log_v1.sql の audit_row_change を再利用)
--    事故報告は後から書き換えられると重大なので、最初からトリガを張る。
-- ============================================================================
DO $$
DECLARE t TEXT;
BEGIN
  IF to_regprocedure('audit_row_change()') IS NULL THEN
    RAISE NOTICE '  − audit_row_change() が無いので監査トリガはスキップ (audit_log_v1.sql を先に適用)';
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY['kaigo_incident_reports', 'kaigo_complaints'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'trg_audit_' || t, t);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION audit_row_change()',
      'trg_audit_' || t, t);
    RAISE NOTICE '  ✓ 監査トリガ: %', t;
  END LOOP;
END $$;

-- ============================================================================
-- 5) 検証
-- ============================================================================
DO $$
DECLARE t TEXT; v_pol INT; v_rls BOOLEAN;
BEGIN
  FOREACH t IN ARRAY ARRAY['kaigo_incident_reports', 'kaigo_complaints'] LOOP
    SELECT c.relrowsecurity INTO v_rls
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = t;
    SELECT COUNT(*) INTO v_pol FROM pg_policies
     WHERE schemaname = 'public' AND tablename = t;
    IF NOT v_rls OR v_pol <> 1 THEN
      RAISE EXCEPTION '検証失敗: % (RLS=% / policy=% 件)', t, v_rls, v_pol;
    END IF;
  END LOOP;
  RAISE NOTICE '✓ 事故報告書 / 苦情受付簿 を新設しました (RLS tenant scope + 監査ログ)';
END $$;

COMMIT;

-- ロールバック:
--   DROP TABLE IF EXISTS kaigo_incident_reports;
--   DROP TABLE IF EXISTS kaigo_complaints;
