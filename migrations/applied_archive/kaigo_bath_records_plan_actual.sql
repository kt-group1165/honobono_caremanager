-- 訪問入浴 実施記録に 予定/実績 区分を追加 (提供表を訪問介護と同じ予定・実績2行にするため)
-- Phase: 訪問入浴 提供表 予定/実績化 (user 確定 2026-07-08)
--
-- planned = 予定, actual = 実績(実施済)。既存レコードは実績なので両方 true。
-- 請求(aggregateBathVisitSeikyu)は actual=true のみを集計する。
--
-- Supabase SQL Editor に貼って実行。

BEGIN;

ALTER TABLE kaigo_bath_visit_records ADD COLUMN IF NOT EXISTS planned BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE kaigo_bath_visit_records ADD COLUMN IF NOT EXISTS actual  BOOLEAN NOT NULL DEFAULT true;

COMMIT;
