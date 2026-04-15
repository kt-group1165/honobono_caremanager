-- 047: サンプル事業所名（○○、△△、××）を実在マスタの事業所に置換
-- 種別に応じたマッピング:
--   通所介護(15): ○○デイサービス → 奈良デイサービスセンター
--   訪問介護(11): ○○訪問介護 → 奈良訪問介護ステーション (or 大和郡山訪問介護センター)
--   訪問看護(13): ○○訪問看護 → 奈良訪問看護ステーション
--   福祉用具(17): △△福祉用具 → 奈良福祉用具サービス
--   短期入所(21): ○○ショートステイ → 奈良ショートステイひまわり
--   通所リハ(16): ○○デイケア → 生駒デイケアセンター
--   訪問リハ(14): ○○訪問リハ → 奈良リハビリセンター
--   居宅介護支援(43): ○○居宅介護支援 → 奈良居宅介護支援センター

-- =====================================================
-- ① kaigo_care_plan_services.provider の置換
-- =====================================================
UPDATE kaigo_care_plan_services SET provider = '奈良デイサービスセンター'
  WHERE provider ~ '○○デイサービス|デイサービスセンター' AND provider !~ '奈良|生駒';
UPDATE kaigo_care_plan_services SET provider = '生駒デイケアセンター'
  WHERE provider ~ '○○デイケア' AND provider !~ '奈良|生駒';
UPDATE kaigo_care_plan_services SET provider = '奈良訪問介護ステーション'
  WHERE provider ~ '○○訪問介護' AND provider !~ '奈良|大和郡山';
UPDATE kaigo_care_plan_services SET provider = '奈良訪問看護ステーション'
  WHERE provider ~ '○○訪問看護' AND provider !~ '奈良';
UPDATE kaigo_care_plan_services SET provider = '奈良リハビリセンター'
  WHERE provider ~ '○○訪問リハ|訪問リハビリ' AND provider !~ '奈良';
UPDATE kaigo_care_plan_services SET provider = '奈良福祉用具サービス'
  WHERE provider ~ '△△福祉用具|○○福祉用具|福祉用具' AND provider !~ '奈良|ケア・サポート|介護ショップ';
UPDATE kaigo_care_plan_services SET provider = '奈良ショートステイひまわり'
  WHERE provider ~ '○○ショートステイ|ショートステイ' AND provider !~ '奈良';
UPDATE kaigo_care_plan_services SET provider = '奈良居宅介護支援センター'
  WHERE provider ~ '○○居宅介護支援|○○ケアマネ' AND provider !~ '奈良';

-- service_content 内の事業所名も置換（内容テキストの中に混入している場合）
UPDATE kaigo_care_plan_services SET service_content = REPLACE(service_content, '○○デイサービスセンター', '奈良デイサービスセンター')
  WHERE service_content LIKE '%○○デイサービスセンター%';
UPDATE kaigo_care_plan_services SET service_content = REPLACE(service_content, '○○訪問介護ステーション', '奈良訪問介護ステーション')
  WHERE service_content LIKE '%○○訪問介護ステーション%';
UPDATE kaigo_care_plan_services SET service_content = REPLACE(service_content, '○○訪問看護ステーション', '奈良訪問看護ステーション')
  WHERE service_content LIKE '%○○訪問看護ステーション%';
UPDATE kaigo_care_plan_services SET service_content = REPLACE(service_content, '△△福祉用具', '奈良福祉用具サービス')
  WHERE service_content LIKE '%△△福祉用具%';

-- =====================================================
-- ② kaigo_report_documents.content 内のJSONB置換
-- 第2表(care-plan-2)/第3表(care-plan-3)のJSON内のprovider名
-- =====================================================
-- JSONBを文字列化→正規表現置換→JSONB化で一括置換
UPDATE kaigo_report_documents
SET content = REPLACE(content::text, '○○デイサービスセンター', '奈良デイサービスセンター')::jsonb
  WHERE content::text LIKE '%○○デイサービスセンター%';

UPDATE kaigo_report_documents
SET content = REPLACE(content::text, '○○訪問介護ステーション', '奈良訪問介護ステーション')::jsonb
  WHERE content::text LIKE '%○○訪問介護ステーション%';

UPDATE kaigo_report_documents
SET content = REPLACE(content::text, '○○訪問看護ステーション', '奈良訪問看護ステーション')::jsonb
  WHERE content::text LIKE '%○○訪問看護ステーション%';

UPDATE kaigo_report_documents
SET content = REPLACE(content::text, '△△福祉用具', '奈良福祉用具サービス')::jsonb
  WHERE content::text LIKE '%△△福祉用具%';

UPDATE kaigo_report_documents
SET content = REPLACE(content::text, '○○デイケア', '生駒デイケアセンター')::jsonb
  WHERE content::text LIKE '%○○デイケア%';

UPDATE kaigo_report_documents
SET content = REPLACE(content::text, '○○訪問リハ', '奈良リハビリセンター')::jsonb
  WHERE content::text LIKE '%○○訪問リハ%';

UPDATE kaigo_report_documents
SET content = REPLACE(content::text, '○○ショートステイ', '奈良ショートステイひまわり')::jsonb
  WHERE content::text LIKE '%○○ショートステイ%';

UPDATE kaigo_report_documents
SET content = REPLACE(content::text, '○○居宅介護支援', '奈良居宅介護支援センター')::jsonb
  WHERE content::text LIKE '%○○居宅介護支援%';

-- 汎用的な ○○ や △△ が残っていれば、これだけ残して報告
-- （念のためログ出力）

-- =====================================================
-- ③ kaigo_emergency_sheets.services_in_use JSONB置換
-- =====================================================
UPDATE kaigo_emergency_sheets
SET services_in_use = REPLACE(services_in_use::text, '○○デイサービスセンター', '奈良デイサービスセンター')::jsonb
  WHERE services_in_use::text LIKE '%○○デイサービスセンター%';

UPDATE kaigo_emergency_sheets
SET services_in_use = REPLACE(services_in_use::text, '○○訪問介護ステーション', '奈良訪問介護ステーション')::jsonb
  WHERE services_in_use::text LIKE '%○○訪問介護ステーション%';

UPDATE kaigo_emergency_sheets
SET services_in_use = REPLACE(services_in_use::text, '○○訪問看護ステーション', '奈良訪問看護ステーション')::jsonb
  WHERE services_in_use::text LIKE '%○○訪問看護ステーション%';

UPDATE kaigo_emergency_sheets
SET services_in_use = REPLACE(services_in_use::text, '△△福祉用具', '奈良福祉用具サービス')::jsonb
  WHERE services_in_use::text LIKE '%△△福祉用具%';

-- 緊急時シートの主治医フィールドも置換
UPDATE kaigo_emergency_sheets SET doctor_hospital = REPLACE(doctor_hospital, '○○クリニック', '奈良在宅医療クリニック')
  WHERE doctor_hospital LIKE '%○○%';
UPDATE kaigo_emergency_sheets SET doctor_hospital = REPLACE(doctor_hospital, '○○病院', '奈良在宅医療クリニック')
  WHERE doctor_hospital LIKE '%○○%';
UPDATE kaigo_emergency_sheets SET doctor2_hospital = REPLACE(doctor2_hospital, '○○クリニック', '奈良在宅医療クリニック')
  WHERE doctor2_hospital LIKE '%○○%';

-- =====================================================
-- ④ kaigo_medical_history の hospital 置換
-- =====================================================
UPDATE kaigo_medical_history SET hospital = '奈良在宅医療クリニック'
  WHERE hospital ~ '○○病院|○○クリニック' AND hospital !~ '奈良|生駒';

-- =====================================================
-- ⑤ kaigo_hospitalizations の hospital_name 置換
-- =====================================================
UPDATE kaigo_hospitalizations SET hospital_name = '奈良在宅医療クリニック'
  WHERE hospital_name ~ '○○病院|○○クリニック' AND hospital_name !~ '奈良|生駒';
