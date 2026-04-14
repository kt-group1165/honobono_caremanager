-- 037: kaigo_visit_records の service_type CHECK制約を緩和
-- サービスコード名（身体介護1等）が入れられるようにする

-- 既存のCHECK制約を削除
ALTER TABLE kaigo_visit_records DROP CONSTRAINT IF EXISTS kaigo_visit_records_service_type_check;

-- 制約なし（TEXT型のまま自由入力可能に）
-- サービスコードマスタから取得した名前がそのまま入る
