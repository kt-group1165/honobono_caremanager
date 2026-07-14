-- ============================================================================
-- 千葉市地域生活支援給付 (移動支援 + 訪問入浴[障害]) Phase 1: マスタ + 記録
--
-- 内容:
--   1. kaigo_service_codes.system CHECK に '地域生活支援' を追加
--   2. 移動支援 実績記録テーブル kaigo_idou_shien_records 新設
--   3. kaigo_bath_visit_records に scheme 列 (介護保険 / 地域生活支援) を追加
--
-- 制度定義: apps/kaigo-app/migrations/_if_idou_shien_chiba.txt
-- コード投入: 適用後に seed_chiiki_chiba_service_codes.mjs を実行
--   node migrations/seed_chiiki_chiba_service_codes.mjs           (DRY RUN)
--   node migrations/seed_chiiki_chiba_service_codes.mjs --execute (本実行)
--
-- Supabase SQL Editor にこのまま貼って Run (BEGIN〜COMMIT 1 ブロック)。
-- 冪等: 再実行しても安全 (IF NOT EXISTS / DROP CONSTRAINT IF EXISTS)。
-- ============================================================================

BEGIN;

-- ── 1. system CHECK に '地域生活支援' を追加 ────────────────────────────────
ALTER TABLE kaigo_service_codes DROP CONSTRAINT IF EXISTS kaigo_service_codes_system_check;
ALTER TABLE kaigo_service_codes ADD CONSTRAINT kaigo_service_codes_system_check
  CHECK (system IN ('介護', '障害', '総合事業', '独自', '地域生活支援'));

-- ── 2. 移動支援 実績記録 ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kaigo_idou_shien_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  office_id UUID,
  tenant_id TEXT NOT NULL DEFAULT 'kt-group',
  service_date DATE NOT NULL,
  -- 移動支援計画 (実績記録票 様式3-1 の計画欄)
  plan_start_time TIME,
  plan_end_time TIME,
  -- サービス提供実績
  start_time TIME,
  end_time TIME,
  -- 運転中など常時支援でない時間の控除 (分)
  deduct_minutes INTEGER NOT NULL DEFAULT 0,
  -- 算定時間 (分) = 実績 − 控除 (アプリ側で計算して保存)
  calc_minutes INTEGER,
  -- 身体介護有り (移動1) / 無し (移動2)
  with_body_care BOOLEAN NOT NULL DEFAULT false,
  -- 派遣人数 (2 = 2人目従業者コードを追加請求)
  staff_count INTEGER NOT NULL DEFAULT 1 CHECK (staff_count IN (1, 2)),
  staff_ids UUID[] NOT NULL DEFAULT '{}',
  -- 解決済みの千葉市サービスコード (時間帯跨ぎ等で未解決なら NULL)
  service_code TEXT,
  units INTEGER,
  -- 行き先・外出目的
  destination TEXT,
  addon_shokai BOOLEAN NOT NULL DEFAULT false,   -- 初回加算 (月1回 218単位)
  addon_kinkyu BOOLEAN NOT NULL DEFAULT false,   -- 緊急時対応加算 (身体介護有りのみ 月2回 109単位)
  user_confirmed BOOLEAN NOT NULL DEFAULT false, -- 実績記録票の利用者確認欄
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'submitted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_idou_records_office_date
  ON kaigo_idou_shien_records (office_id, service_date);
CREATE INDEX IF NOT EXISTS idx_idou_records_client_date
  ON kaigo_idou_shien_records (client_id, service_date);

DROP TRIGGER IF EXISTS trg_idou_records_updated_at ON kaigo_idou_shien_records;
CREATE TRIGGER trg_idou_records_updated_at
  BEFORE UPDATE ON kaigo_idou_shien_records
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE kaigo_idou_shien_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_all" ON kaigo_idou_shien_records;
CREATE POLICY "authenticated_all" ON kaigo_idou_shien_records
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── 3. 訪問入浴記録に制度フラグ ────────────────────────────────────────────
-- 既存レコードはすべて介護保険の訪問入浴介護なので DEFAULT で埋まる
ALTER TABLE kaigo_bath_visit_records
  ADD COLUMN IF NOT EXISTS scheme TEXT NOT NULL DEFAULT '介護保険';
ALTER TABLE kaigo_bath_visit_records DROP CONSTRAINT IF EXISTS kaigo_bath_visit_records_scheme_check;
ALTER TABLE kaigo_bath_visit_records ADD CONSTRAINT kaigo_bath_visit_records_scheme_check
  CHECK (scheme IN ('介護保険', '地域生活支援'));

COMMIT;

-- ── 確認クエリ ──────────────────────────────────────────────────────────────
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'kaigo_service_codes_system_check';
-- SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'kaigo_idou_shien_records' ORDER BY ordinal_position;
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'kaigo_bath_visit_records' AND column_name = 'scheme';

-- ── 補足: offices.service_type ──────────────────────────────────────────────
-- 移動支援事業所を登録する前に、共通マスタ offices の service_type に CHECK 制約が
-- あるか確認すること (無ければそのまま '移動支援' で INSERT 可能):
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid = 'offices'::regclass AND contype = 'c';
-- CHECK がある場合は DROP → '移動支援' を含めて ADD し直す (DROP→UPDATE→ADD の順)。

-- ── ロールバック ────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS kaigo_idou_shien_records;
-- ALTER TABLE kaigo_bath_visit_records DROP COLUMN IF EXISTS scheme;
-- (system CHECK は '地域生活支援' の行を削除してから元の 4 値に戻す)
