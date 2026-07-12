-- ============================================================================
-- 国保連 審査結果・返戻・支払通知ファイル取込 (ほのぼの「返戻管理くん」+「審査結果取込」相当)
--
--   kokuho_shinsa_notice_files: 取込ファイル単位の raw 保存 (監査可能性)
--   kokuho_shinsa_notice_rows : データレコード (明細行) 単位の構造化 + raw 保存
--
-- 対応する交換情報識別番号 (レイアウト根拠は src/lib/kokuho-tsuchi/parse.ts 冒頭コメント):
--   7411 = 請求明細書・給付管理票返戻（保留）一覧表情報 → kaigo_billing_status.henrei 自動セット
--   7511/7513 = 介護給付費(等)支払決定額通知書情報      → kokuho_nyukin_records.kettei_amount 取込
--   7521 = 介護給付費支払決定額内訳書情報               → 一覧表示 (raw 保存)
--   7211 = 介護保険審査決定増減表情報 (増減単位数通知)  → 査定減の一覧表示 (フラグは立てない)
--
-- 適用: Supabase SQL Editor に全文貼付けて Run (BEGIN〜COMMIT 一括・冪等)
-- 未適用でもアプリは壊れない (取込画面がガイダンス表示のみにフォールバック)
-- ============================================================================

BEGIN;

-- ── ファイル単位 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kokuho_shinsa_notice_files (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             TEXT NOT NULL DEFAULT 'kt-group',
  office_id             UUID NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  file_name             TEXT NOT NULL,
  -- コントロールレコードのデータ種別 (交換情報識別番号の上3桁: 741/751/752/721 等)
  data_type             TEXT,
  -- ファイルに含まれる交換情報識別番号の一覧 (7411/7511/7521/7211/未対応コード)
  exchange_numbers      TEXT[] NOT NULL DEFAULT '{}',
  -- 審査年月 'YYYY-MM' (ヘッダレコード優先、無ければコントロールの処理対象年月)
  shinsa_ym             TEXT,
  -- ヘッダ/通知書に記載の事業所番号 (自事業所チェック用)
  control_office_number TEXT,
  record_count          INTEGER,
  -- 生ファイル全文 (Shift_JIS → Unicode 変換済み)。監査・再パース用
  raw_content           TEXT NOT NULL,
  imported_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kokuho_shinsa_files_office
  ON kokuho_shinsa_notice_files(office_id, shinsa_ym);
CREATE INDEX IF NOT EXISTS idx_kokuho_shinsa_files_tenant
  ON kokuho_shinsa_notice_files(tenant_id);

-- ── 明細行単位 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kokuho_shinsa_notice_rows (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL DEFAULT 'kt-group',
  file_id           UUID NOT NULL REFERENCES kokuho_shinsa_notice_files(id) ON DELETE CASCADE,
  office_id         UUID NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  -- henrei=7411 / shiharai_kettei=7511・7513 / shiharai_uchiwake=7521 / zougen=7211 / unknown=未対応
  notice_type       TEXT NOT NULL CHECK (notice_type IN
                      ('henrei', 'shiharai_kettei', 'shiharai_uchiwake', 'zougen', 'unknown')),
  exchange_number   TEXT NOT NULL,          -- 交換情報識別番号 (7411 等)
  record_kind       TEXT NOT NULL,          -- 帳票レコード種別 (H1/D1/T1/T2/T3)
  row_index         INTEGER NOT NULL,       -- ファイル内レコード番号 (連番)
  shinsa_ym         TEXT,                   -- 審査年月 'YYYY-MM'
  service_ym        TEXT,                   -- サービス提供年月 'YYYY-MM'
  insurer_number    TEXT,                   -- 保険者番号 (又は公費負担者番号)
  insured_number    TEXT,                   -- 被保険者番号 (7411 明細)
  kana_name         TEXT,                   -- 被保険者カナ氏名
  shubetsu          TEXT,                   -- 種別: サ/請/給 (7411)
  service_kind_code TEXT,                   -- サービス種類コード
  tanisu            BIGINT,                 -- 単位数 (7411=返戻単位数 / 7211=査定増減単位数)
  jiyu_code         TEXT,                   -- 返戻事由記号 A-E (7411)
  jiyu_naiyo        TEXT,                   -- 返戻事由の内容 (7411)
  biko              TEXT,                   -- 備考 (保留区分等)
  amount            BIGINT,                 -- 金額 (7511=振込金額 / 7521=介護サービス金額)
  -- 全フィールドの raw (fields: string[]) + 構造化済み parsed。列位置の実ファイル検証・再解釈用
  payload           JSONB NOT NULL DEFAULT '{}',
  -- 被保険者番号 → 利用者 突合結果。unmatched 行は「未突合」として画面に残す (silent skip 禁止)
  client_id         UUID REFERENCES clients(id) ON DELETE SET NULL,
  match_status      TEXT NOT NULL DEFAULT 'na' CHECK (match_status IN ('matched', 'unmatched', 'na')),
  -- 確定時の自動処理 (henrei フラグ / kettei_amount) を反映済みか
  applied           BOOLEAN NOT NULL DEFAULT false,
  applied_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kokuho_shinsa_rows_file
  ON kokuho_shinsa_notice_rows(file_id);
CREATE INDEX IF NOT EXISTS idx_kokuho_shinsa_rows_office_ym
  ON kokuho_shinsa_notice_rows(office_id, shinsa_ym, notice_type);
CREATE INDEX IF NOT EXISTS idx_kokuho_shinsa_rows_client
  ON kokuho_shinsa_notice_rows(client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kokuho_shinsa_rows_insured
  ON kokuho_shinsa_notice_rows(insured_number) WHERE insured_number IS NOT NULL;

-- ── RLS (既存 kaigo_* テーブルと同じ authenticated 全許可パターン) ──
ALTER TABLE kokuho_shinsa_notice_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE kokuho_shinsa_notice_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kokuho_shinsa_files_auth ON kokuho_shinsa_notice_files;
CREATE POLICY kokuho_shinsa_files_auth
  ON kokuho_shinsa_notice_files FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS kokuho_shinsa_rows_auth ON kokuho_shinsa_notice_rows;
CREATE POLICY kokuho_shinsa_rows_auth
  ON kokuho_shinsa_notice_rows FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMIT;
