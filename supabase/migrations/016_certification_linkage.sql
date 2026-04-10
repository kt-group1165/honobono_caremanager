-- アセスメント・帳票を認定期間に紐付け
-- 1認定期間に複数のアセスメント/計画書があり得るため、nullable で関連付け

ALTER TABLE kaigo_assessments ADD COLUMN IF NOT EXISTS certification_id UUID REFERENCES kaigo_care_certifications(id) ON DELETE SET NULL;
ALTER TABLE kaigo_report_documents ADD COLUMN IF NOT EXISTS certification_id UUID REFERENCES kaigo_care_certifications(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_kaigo_assessments_cert ON kaigo_assessments(certification_id);
CREATE INDEX IF NOT EXISTS idx_kaigo_report_documents_cert ON kaigo_report_documents(certification_id);
