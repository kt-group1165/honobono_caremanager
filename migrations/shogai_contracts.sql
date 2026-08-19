-- ============================================================================
-- shogai_contracts — 障害福祉サービスの契約情報 (受給者証「事業者記入欄」)
--
-- ── なぜテーブルにするか ──────────────────────────────────────────────
--   伝送の J121 契約情報レコード (05) は **決定サービスコードごとに 1 レコード必須**
--   (原典 サービス事業所編 P.29: 項7/8/9/11 = ◎必須、項10 契約終了年月日 = ○)。
--   実データでも 1 利用者が複数行を持つ:
--     松戸孝雄  111000 身体介護 32.5h / 112000 家事援助 32.5h / 113000 通院等介助 5h
--   支給量も契約日も終了日もサービスごとに違うため、
--   shougai_certifications.contract_amount_text ("家事31 身体77.5 通院25") の
--   テキスト 1 本では表現できない (表記ゆれのパースも壊れる)。
--
-- ── 履歴として積む ────────────────────────────────────────────────────
--   支給量を変えたら **新しい行を足し、古い行に end_date を入れる**。
--   請求時は「その月に有効な行」を引く。月遅れ・過誤の再請求で過去月を作り直しても
--   当時の契約が正しく出る。
--
-- ── 契約支給量の単位 ──────────────────────────────────────────────────
--   伝送は「整数3桁+小数2桁」の 5 桁 (100.5時間→10050 / 12日→01200 / 5回→00500)。
--   ここでは **小数2桁を保った整数** (amount_x100) で持つ。32時間30分 → 3250。
--   浮動小数だと 32.5 が 32.499… になり伝送で 1 桁ずれるため整数で持つこと。
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS shogai_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'kt-group',
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  office_id uuid NOT NULL REFERENCES offices(id) ON DELETE CASCADE,

  -- 決定サービスコード (6桁)。111000 身体介護 / 112000 家事援助 /
  -- 113000 通院介助(伴う) / 114000 通院介助(伴わず) / 115000 通院等乗降介助 /
  -- 121000・122000・123000 重度訪問介護 / 120901 加算移動介護 /
  -- 151000〜154000 同行援護 / 141000 重度包括
  decision_code text NOT NULL CHECK (decision_code ~ '^[0-9]{6}$'),

  -- 契約支給量。小数2桁を保った整数 (32時間30分 → 3250 / 12日 → 1200 / 5回 → 500)
  amount_x100 integer NOT NULL CHECK (amount_x100 >= 0),
  -- 単位。決定コードで決まるが、読み手のために明示する
  amount_unit text NOT NULL DEFAULT '時間' CHECK (amount_unit IN ('時間', '日', '回')),

  -- 受給者証の事業者記入欄番号 (2桁)。伝送 項11
  entry_number smallint CHECK (entry_number BETWEEN 1 AND 99),

  start_date date NOT NULL,               -- 契約日 (伝送 項9)
  end_date date,                          -- 契約終了日 (伝送 項10)。継続中は NULL
  -- 契約終了月に提供済の量 (様式第26号「提供終了月中の既提供量」)。終了時のみ
  provided_before_end_x100 integer,

  reason text NOT NULL DEFAULT '新規契約'
    CHECK (reason IN ('新規契約', '契約変更', '契約終了')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CHECK (end_date IS NULL OR end_date >= start_date)
);

COMMENT ON TABLE shogai_contracts IS
  '障害の契約情報 (受給者証 事業者記入欄)。伝送 J121-05 の出所。決定サービスコードごとに1行、変更は履歴として積む';
COMMENT ON COLUMN shogai_contracts.amount_x100 IS
  '契約支給量。小数2桁を保った整数 (32時間30分=3250)。伝送は5桁ゼロ埋めで出す';

-- 同じ利用者×事業所×決定コードで期間が重なる契約は作らせない
CREATE UNIQUE INDEX IF NOT EXISTS shogai_contracts_uniq
  ON shogai_contracts (client_id, office_id, decision_code, start_date);
CREATE INDEX IF NOT EXISTS shogai_contracts_lookup
  ON shogai_contracts (office_id, client_id, decision_code, start_date DESC);

ALTER TABLE shogai_contracts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shogai_contracts_rw ON shogai_contracts;
CREATE POLICY shogai_contracts_rw ON shogai_contracts
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
