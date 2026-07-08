-- ═══════════════════════════════════════════════════════════════════════════
-- ケアカンファレンス記録 (訪問介護の個別援助会議記録) — /care-conferences 用
--
-- 背景:
--   訪問介護版の「カンファレンス記録」画面 (2026-07 総点検で新設) の保存先。
--   居宅のサービス担当者会議 (第4表 = kaigo_report_documents meeting-minutes) とは別物。
--
-- 適用: Supabase SQL Editor に全文貼り付けて Run (BEGIN〜COMMIT の 1 ブロック)
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS kaigo_care_conferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL DEFAULT 'kt-group',
  -- 開催した訪問介護事業所 (offices.id)。NULL 許容 (office 未解決の環境向け)
  office_id UUID,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- 開催日
  held_on DATE NOT NULL,
  -- 出席者 (自由記載: 氏名・職種を改行/カンマ区切り)
  attendees TEXT,
  -- 検討内容 (議題・討議内容)
  agenda TEXT,
  -- 結論 (決定事項・対応方針)
  conclusion TEXT,
  -- 備考 (残された課題・次回予定 等)
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kaigo_care_conferences_client_held
  ON kaigo_care_conferences (client_id, held_on DESC);

ALTER TABLE kaigo_care_conferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kaigo_care_conferences_authenticated_all ON kaigo_care_conferences;
CREATE POLICY kaigo_care_conferences_authenticated_all
  ON kaigo_care_conferences
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

COMMIT;

-- 適用後の確認:
--   SELECT count(*) FROM kaigo_care_conferences;
