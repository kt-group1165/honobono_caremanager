-- 居宅介護支援レセプトの加算カラム追加
-- 既存: initial_addition, hospital_coordination, discharge_addition, medical_coordination

-- 特定事業所加算（自事業所設定から自動適用）
ALTER TABLE kaigo_care_support_claims ADD COLUMN IF NOT EXISTS tokutei_kassan_type TEXT DEFAULT 'なし';
ALTER TABLE kaigo_care_support_claims ADD COLUMN IF NOT EXISTS tokutei_kassan_units INTEGER DEFAULT 0;

-- 特定事業所医療介護連携加算
ALTER TABLE kaigo_care_support_claims ADD COLUMN IF NOT EXISTS medical_coop_kassan BOOLEAN DEFAULT FALSE;
ALTER TABLE kaigo_care_support_claims ADD COLUMN IF NOT EXISTS medical_coop_kassan_units INTEGER DEFAULT 0;

-- 退院・退所加算の区分細分化
ALTER TABLE kaigo_care_support_claims ADD COLUMN IF NOT EXISTS discharge_type TEXT DEFAULT '';
-- 退院・退所加算(i)イ 450単位、(i)ロ 600単位、(ii)イ 600単位、(ii)ロ 750単位、(iii) 900単位

-- ターミナルケアマネジメント加算
ALTER TABLE kaigo_care_support_claims ADD COLUMN IF NOT EXISTS terminal_care BOOLEAN DEFAULT FALSE;
ALTER TABLE kaigo_care_support_claims ADD COLUMN IF NOT EXISTS terminal_care_units INTEGER DEFAULT 0;

-- 緊急時等居宅カンファレンス加算
ALTER TABLE kaigo_care_support_claims ADD COLUMN IF NOT EXISTS emergency_conference BOOLEAN DEFAULT FALSE;
ALTER TABLE kaigo_care_support_claims ADD COLUMN IF NOT EXISTS emergency_conference_units INTEGER DEFAULT 0;

-- 業務継続計画未策定減算
ALTER TABLE kaigo_care_support_claims ADD COLUMN IF NOT EXISTS bcp_not_prepared BOOLEAN DEFAULT FALSE;
ALTER TABLE kaigo_care_support_claims ADD COLUMN IF NOT EXISTS bcp_reduction_pct INTEGER DEFAULT 0;

-- 高齢者虐待防止措置未実施減算
ALTER TABLE kaigo_care_support_claims ADD COLUMN IF NOT EXISTS abuse_prevention_not_implemented BOOLEAN DEFAULT FALSE;
ALTER TABLE kaigo_care_support_claims ADD COLUMN IF NOT EXISTS abuse_reduction_pct INTEGER DEFAULT 0;
