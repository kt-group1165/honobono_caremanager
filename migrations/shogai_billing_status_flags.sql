-- ============================================================================
-- shogai_billing_status に 月遅れ/返戻/過誤 フラグを追加 (障害の再請求フロー)
-- ============================================================================
-- 2026-07-15。介護 (kaigo_billing_status の tsukiokure/henrei/kago) と対称に、
-- 障害請求でも月遅れ・返戻・過誤の再請求 (元提供月で再集計して当月に合流) を可能にする。
--   再請求対象 = フラグ true かつ densou_target=false の「過去月」レコード
--   (介護は kokuho_target、障害は densou_target が「伝送対象化済み」の意味)。
-- 過誤の付帯列は kaigo と同名にして UI ロジックを共有できるようにする。
--
-- Supabase SQL Editor に貼って Run。冪等 (IF NOT EXISTS)。未適用でもアプリは
-- 従来どおり動く (再請求フラグ UI は無効表示、集計・伝送は当月分のみ)。
-- ============================================================================
BEGIN;

ALTER TABLE shogai_billing_status
  ADD COLUMN IF NOT EXISTS tsukiokure BOOLEAN NOT NULL DEFAULT false,  -- 月遅れ
  ADD COLUMN IF NOT EXISTS henrei     BOOLEAN NOT NULL DEFAULT false,  -- 返戻
  ADD COLUMN IF NOT EXISTS kago       BOOLEAN NOT NULL DEFAULT false,  -- 過誤 (支払済取下げ後の再請求)
  ADD COLUMN IF NOT EXISTS kago_moushitate_date DATE,                 -- 過誤申立日
  ADD COLUMN IF NOT EXISTS kago_jiyu_code TEXT,                       -- 過誤事由コード (4桁)
  ADD COLUMN IF NOT EXISTS kago_dougetsu BOOLEAN NOT NULL DEFAULT false; -- 同月過誤

COMMENT ON COLUMN shogai_billing_status.tsukiokure IS '月遅れ請求フラグ。true かつ densou_target=false の過去月は翌月に再請求合流';
COMMENT ON COLUMN shogai_billing_status.henrei IS '返戻フラグ。原因修正後に元提供月で再請求';
COMMENT ON COLUMN shogai_billing_status.kago IS '過誤フラグ。支払済レセプトの取下げ後の再請求 (通常過誤は過誤決定の翌月以降)';

-- 再請求検出クエリ (フラグ true AND densou_target=false AND 過去月) の索引
CREATE INDEX IF NOT EXISTS idx_shogai_billing_status_reseikyu
  ON shogai_billing_status (office_id, target_month)
  WHERE densou_target = false AND (tsukiokure OR henrei OR kago);

COMMIT;

-- 検証:
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'shogai_billing_status' ORDER BY ordinal_position;
