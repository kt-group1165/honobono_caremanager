-- 035: 訪問記録テーブルの拡張（呼吸数・血糖値・経過記録を追加）

-- 呼吸数
ALTER TABLE kaigo_visit_records ADD COLUMN IF NOT EXISTS vital_respiration INTEGER;

-- 血糖値
ALTER TABLE kaigo_visit_records ADD COLUMN IF NOT EXISTS vital_blood_sugar INTEGER;

-- 経過記録
ALTER TABLE kaigo_visit_records ADD COLUMN IF NOT EXISTS progress_notes TEXT;
