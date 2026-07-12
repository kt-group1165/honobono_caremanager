-- ============================================================================
-- 過誤 (かご) の再請求フロー — 過誤申立の管理列を kaigo_billing_status に追加
-- ============================================================================
-- 過誤 = 一度支払われたレセプトを事後に取り下げる手続き。
--   ① 事業所 → 保険者 へ過誤申立 (様式は保険者ごと)
--   ② 保険者 → 国保連 (介護給付費過誤申立書情報 1731)
--   ③ 国保連が過誤決定 (支払額から控除。過誤決定通知書 1711)
--   ④ 事業所が正しい内容で再請求
--      - 通常過誤: 過誤決定の翌月以降に再請求
--      - 同月過誤: 過誤と再請求を同月処理 (保険者が対応している場合のみ)
--
-- 追加列:
--   kago_moushitate_date  過誤申立日 (保険者へ申立書を提出した日)
--   kago_jiyu_code        過誤申立事由コード (英数4桁 = 様式番号2桁 + 申立理由番号2桁)
--                         根拠: 国保中央会インタフェース仕様書 項番102
--                         (migrations/_if_kyotaku.txt)。保険者ごとに使用範囲が
--                         異なるため enum CHECK にはせず形式のみ検査。
--   kago_dougetsu         同月過誤フラグ (過誤申立と再請求を同月処理)
--
-- アプリ側の運用 (billing-visit/kaigo-seikyu 右ペイン「過誤申立」ブロック):
--   申立を登録すると kago=true + kokuho_target=false (取下げ = 国保対象から外す)。
--   翌月以降の請求画面に再請求候補として合流し、再度国保対象化 (kokuho_target=true)
--   すると再請求済みとなる (月遅れ/返戻の re-seikyu と同じ判定)。
--
-- 冪等: ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS。
-- bath_billing_status (訪問入浴。schema 同型) は存在する場合のみ同列を追加。

BEGIN;

ALTER TABLE kaigo_billing_status
  ADD COLUMN IF NOT EXISTS kago_moushitate_date DATE,
  ADD COLUMN IF NOT EXISTS kago_jiyu_code TEXT,
  ADD COLUMN IF NOT EXISTS kago_dougetsu BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN kaigo_billing_status.kago_moushitate_date IS
  '過誤申立日 (保険者へ過誤申立書を提出した日)';
COMMENT ON COLUMN kaigo_billing_status.kago_jiyu_code IS
  '過誤申立事由コード (4桁 = 様式番号2桁 + 申立理由番号2桁。例: 1002 = 訪問介護等の請求誤りによる実績取下げ)';
COMMENT ON COLUMN kaigo_billing_status.kago_dougetsu IS
  '同月過誤 (過誤申立と再請求を同月処理。保険者が対応している場合のみ)';

-- 形式チェックのみ (4桁英数)。理由番号の値域は保険者ごとに異なるため縛らない。
ALTER TABLE kaigo_billing_status
  DROP CONSTRAINT IF EXISTS kaigo_billing_status_kago_jiyu_code_check;
ALTER TABLE kaigo_billing_status
  ADD CONSTRAINT kaigo_billing_status_kago_jiyu_code_check
  CHECK (kago_jiyu_code IS NULL OR kago_jiyu_code ~ '^[0-9A-Z]{4}$');

-- 訪問入浴 (bath_billing_status) — テーブルが存在する環境のみ (フォールバック)
DO $$
BEGIN
  IF to_regclass('public.bath_billing_status') IS NOT NULL THEN
    ALTER TABLE bath_billing_status
      ADD COLUMN IF NOT EXISTS kago_moushitate_date DATE,
      ADD COLUMN IF NOT EXISTS kago_jiyu_code TEXT,
      ADD COLUMN IF NOT EXISTS kago_dougetsu BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE bath_billing_status
      DROP CONSTRAINT IF EXISTS bath_billing_status_kago_jiyu_code_check;
    ALTER TABLE bath_billing_status
      ADD CONSTRAINT bath_billing_status_kago_jiyu_code_check
      CHECK (kago_jiyu_code IS NULL OR kago_jiyu_code ~ '^[0-9A-Z]{4}$');
  END IF;
END $$;

COMMIT;
