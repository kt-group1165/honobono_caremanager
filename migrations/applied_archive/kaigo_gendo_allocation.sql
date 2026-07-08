-- ═══════════════════════════════════════════════════════════════════════════
-- 区分支給限度基準額 超過の割振り (ほのぼの居宅「利用票別表」の超過欄と同方式)
--
-- 背景 (2026-07-08 ユーザー確定):
--   限度額を超えたとき「どのサービスを自費 (10割) にするか」はケアマネの判断。
--   ほのぼのは別表上で機械が初期値を寄せ、ケアマネが各行の「超過」欄を手入力し直す
--   (「割り振りの残り単位数」を見ながら 0 になるまで配分)。
--   ほのぼの改では同一 DB なので、居宅の別表で割り振った結果をこのテーブルに保存し、
--   訪問介護の請求集計 (aggregate) がこの割振りを「真」として自費額を計算する。
--
-- line_key: 別表の 1 行を一意識別。自法人 office の行は office_id 文字列、
--           他事業所の行は 'ext:' || provider_name || ':' || service_category。
-- source:   'auto' = 機械初期割振り (未確定) / 'manual' = ケアマネ確定入力。
--
-- 適用: Supabase SQL Editor に全文貼付けて Run (BEGIN〜COMMIT 1 ブロック)
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS kaigo_gendo_allocation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL DEFAULT 'kt-group',
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  target_month TEXT NOT NULL,                 -- 'YYYY-MM' (サービス提供月)
  line_key TEXT NOT NULL,                     -- 別表 1 行の安定識別子
  office_id UUID REFERENCES offices(id),      -- 自法人 office の行 (NULL = 他事業所)
  provider_name TEXT,                         -- 他事業所名 (表示用)
  service_category TEXT,                      -- 11=訪問介護 等 (サービス種類コード上2桁)
  service_label TEXT,                         -- 行の表示名 (通所リハ 等)
  total_units INT NOT NULL DEFAULT 0,         -- その行の総単位数 (別表計算時のスナップショット)
  over_units INT NOT NULL DEFAULT 0,          -- 区分支給限度基準を超える単位数 (= 全額自費分)
  source TEXT NOT NULL DEFAULT 'auto'
         CHECK (source IN ('auto', 'manual')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, target_month, line_key)
);

CREATE INDEX IF NOT EXISTS idx_gendo_allocation_month
  ON kaigo_gendo_allocation (target_month);
CREATE INDEX IF NOT EXISTS idx_gendo_allocation_office_month
  ON kaigo_gendo_allocation (office_id, target_month);

ALTER TABLE kaigo_gendo_allocation ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kaigo_gendo_allocation_all ON kaigo_gendo_allocation;
CREATE POLICY kaigo_gendo_allocation_all ON kaigo_gendo_allocation
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
