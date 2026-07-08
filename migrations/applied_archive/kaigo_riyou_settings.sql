-- ============================================================================
-- 利用者請求の個人設定 (軽減率 / 医療費控除対象) — ほのぼの「請求個人設定」相当
-- ============================================================================
-- 2026-07-08。利用請求の 軽減(社福減免等)・医療費控除対象額 の実値化用。

BEGIN;

CREATE TABLE IF NOT EXISTS kaigo_riyou_settings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL DEFAULT 'kt-group',
  client_id         UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  keigen_rate       NUMERIC,             -- 軽減率 (%)。例: 社福軽減 25。NULL=軽減なし
  keigen_start_date DATE,                -- 軽減適用 開始日
  keigen_end_date   DATE,                -- 軽減適用 終了日 (NULL=無期限)
  iryohi_taisho     BOOLEAN NOT NULL DEFAULT false,  -- 医療費控除対象 (医療系サービス併用)
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id)
);

ALTER TABLE kaigo_riyou_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kaigo_riyou_settings_all ON kaigo_riyou_settings;
CREATE POLICY kaigo_riyou_settings_all ON kaigo_riyou_settings
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
