-- kaigo_bath_visit_records : 訪問入浴介護の実施記録（＝請求明細の源）
-- Phase: 訪問入浴版 追加 (user 確定 2026-07-08)
--
-- 設計:
--   訪問入浴は 1回=1レコード。全身浴/部分浴・清拭 × 職員のみ(看護職員同行なし)減算 で
--   算定コード(121111/121112/121121/121122)が決まる。虐防(高齢者虐待防止未実施)・業未
--   (業務継続計画未策定)減算は事業所単位で請求時に適用。処遇改善等の月次加算も請求側。
--   利用者=clients / 職員=members (共有マスタ) を参照。RLS は他 kaigo テーブルと同じ
--   authenticated_all (USING true)。
--
-- Supabase SQL Editor に貼って実行 (BEGIN/COMMIT 入り)。

BEGIN;

CREATE TABLE IF NOT EXISTS kaigo_bath_visit_records (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  office_id     UUID,                                  -- 訪問入浴事業所 (offices.id)
  tenant_id     TEXT NOT NULL DEFAULT 'kt-group',
  visit_date    DATE NOT NULL,
  start_time    TIME,
  end_time      TIME,
  -- 算定
  bath_type     TEXT NOT NULL DEFAULT '全身浴' CHECK (bath_type IN ('全身浴', '部分浴')),
  staff_only    BOOLEAN NOT NULL DEFAULT false,        -- 看護職員が同行しない(職員のみ)=減算
  service_code  TEXT,                                  -- 解決済み算定コード (121111 等)
  staff_ids     UUID[] NOT NULL DEFAULT '{}',          -- 従事職員 (members.id)
  -- バイタル
  vital_temperature NUMERIC,
  vital_bp_sys  INTEGER,
  vital_bp_dia  INTEGER,
  vital_pulse   INTEGER,
  vital_spo2    INTEGER,
  water_temp    NUMERIC,                               -- 湯温
  -- 記録
  condition_before TEXT,                               -- 入浴前の状態
  condition_after  TEXT,                               -- 入浴後の状態
  skin_notes    TEXT,                                  -- 皮膚の観察
  -- 加算 (回単位で算定するもの)
  addon_shokai  BOOLEAN NOT NULL DEFAULT false,        -- 初回加算
  addon_ninchi  TEXT CHECK (addon_ninchi IN ('I', 'II')),  -- 認知症専門ケア加算 (NULL可)
  addon_chuusankan BOOLEAN NOT NULL DEFAULT false,     -- 中山間地域等提供加算
  -- 特記
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'submitted')),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kaigo_bath_records_client ON kaigo_bath_visit_records(client_id);
CREATE INDEX IF NOT EXISTS idx_kaigo_bath_records_date   ON kaigo_bath_visit_records(visit_date);
CREATE INDEX IF NOT EXISTS idx_kaigo_bath_records_office ON kaigo_bath_visit_records(office_id, visit_date);

CREATE TRIGGER update_kaigo_bath_visit_records_updated_at
  BEFORE UPDATE ON kaigo_bath_visit_records
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE kaigo_bath_visit_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_all" ON kaigo_bath_visit_records
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
