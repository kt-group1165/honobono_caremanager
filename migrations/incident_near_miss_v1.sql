-- apps/kaigo-app/migrations/incident_near_miss_v1.sql
-- 2026-09-01  ヒヤリハット報告の置き場を作る。
--
-- 【なぜ要るか】
--   事故報告書は incident_and_complaint_v1.sql で作ったが、**ヒヤリハットは別物**。
--   運営基準の「事故発生の防止のための指針」は、事故そのものだけでなく
--   **ヒヤリハット等の報告・分析・周知**を求めている。実地指導でも
--   「ヒヤリハットの収集をどうしているか」を必ず聞かれる。
--
--   ヒヤリハットは **利用者に実害が及んでいない**ので、事故報告書の
--   「傷害の程度」「市町村への報告」「損害賠償」の欄は使わない。
--   一方で発生状況・要因・再発防止策はまったく同じ形で記録する。
--
-- 【設計】
--   別テーブルにはしない。**同じ台帳を report_kind で分ける**。
--     ・分析は事故とヒヤリハットを合わせて行う (件数比や傾向を一緒に見る)
--     ・「ヒヤリハットで上げたが実は事故だった」の付け替えが 1 列の更新で済む
--     ・列・RLS・監査ログのトリガを二重に持たなくてよい
--
--   既存行はすべて事故報告なので DEFAULT '事故' でそのまま埋まる。

BEGIN;

ALTER TABLE kaigo_incident_reports
  ADD COLUMN IF NOT EXISTS report_kind TEXT NOT NULL DEFAULT '事故';

-- CHECK は「無ければ足す」。既存の CHECK を書き換えるときは DROP → UPDATE → ADD の順で。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'kaigo_incident_reports'::regclass
       AND conname = 'kaigo_incident_reports_report_kind_check'
  ) THEN
    ALTER TABLE kaigo_incident_reports
      ADD CONSTRAINT kaigo_incident_reports_report_kind_check
      CHECK (report_kind IN ('事故', 'ヒヤリハット'));
  END IF;
END $$;

-- 台帳は「事業所 × 種別 × 発生日の新しい順」でしか引かない
CREATE INDEX IF NOT EXISTS idx_incident_kind_office_occurred
  ON kaigo_incident_reports (report_kind, office_id, occurred_at DESC);

COMMENT ON COLUMN kaigo_incident_reports.report_kind IS
  '事故 / ヒヤリハット。ヒヤリハットは実害に至らなかったもので、'
  ' 傷害の程度・市町村への報告・損害賠償の欄は使わない。'
  ' 分析は事故と合わせて行うため同じ台帳に入れる。';

COMMIT;
