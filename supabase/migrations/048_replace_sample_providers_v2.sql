-- 048: サンプル置換 v2 — 複数の丸文字・三角文字のUnicode違いに対応
-- 対応文字:
--   ○ (U+25CB) WHITE CIRCLE
--   〇 (U+3007) IDEOGRAPHIC NUMBER ZERO
--   ◯ (U+25EF) LARGE CIRCLE
--   △ (U+25B3) WHITE UP-POINTING TRIANGLE
--   ▲ (U+25B2) BLACK UP-POINTING TRIANGLE
--   × (U+00D7) MULTIPLICATION SIGN
--   ✕ (U+2715) MULTIPLICATION X

-- ===== kaigo_report_documents.content JSONB =====
-- 正規表現で複数文字にマッチ
DO $$
DECLARE
  rec RECORD;
  new_content TEXT;
BEGIN
  FOR rec IN SELECT id, content FROM kaigo_report_documents WHERE content::text ~ '[○〇◯△▲×✕]' LOOP
    new_content := rec.content::text;
    -- デイサービス
    new_content := regexp_replace(new_content, '[○〇◯]+デイサービス[センタ・ー]*', '奈良デイサービスセンター', 'g');
    -- 訪問介護
    new_content := regexp_replace(new_content, '[○〇◯]+訪問介護[ステーション]*', '奈良訪問介護ステーション', 'g');
    -- 訪問看護
    new_content := regexp_replace(new_content, '[○〇◯]+訪問看護[ステーション]*', '奈良訪問看護ステーション', 'g');
    -- 訪問リハ
    new_content := regexp_replace(new_content, '[○〇◯]+訪問リハ[ビリテーション]*', '奈良リハビリセンター', 'g');
    -- 福祉用具
    new_content := regexp_replace(new_content, '[△▲○〇◯]+福祉用具[サービス]*', '奈良福祉用具サービス', 'g');
    -- デイケア
    new_content := regexp_replace(new_content, '[○〇◯]+デイケア[センタ・ー]*', '生駒デイケアセンター', 'g');
    -- ショートステイ
    new_content := regexp_replace(new_content, '[○〇◯]+ショートステイ', '奈良ショートステイひまわり', 'g');
    -- 居宅介護支援
    new_content := regexp_replace(new_content, '[○〇◯]+居宅介護支援[センタ・ー]*', '奈良居宅介護支援センター', 'g');
    -- 病院/クリニック
    new_content := regexp_replace(new_content, '[○〇◯]+(病院|クリニック)', '奈良在宅医療クリニック', 'g');

    IF new_content != rec.content::text THEN
      UPDATE kaigo_report_documents SET content = new_content::jsonb WHERE id = rec.id;
    END IF;
  END LOOP;
END $$;

-- ===== kaigo_emergency_sheets.services_in_use JSONB =====
DO $$
DECLARE
  rec RECORD;
  new_services TEXT;
BEGIN
  FOR rec IN SELECT id, services_in_use FROM kaigo_emergency_sheets WHERE services_in_use::text ~ '[○〇◯△▲×✕]' LOOP
    new_services := rec.services_in_use::text;
    new_services := regexp_replace(new_services, '[○〇◯]+デイサービス[センタ・ー]*', '奈良デイサービスセンター', 'g');
    new_services := regexp_replace(new_services, '[○〇◯]+訪問介護[ステーション]*', '奈良訪問介護ステーション', 'g');
    new_services := regexp_replace(new_services, '[○〇◯]+訪問看護[ステーション]*', '奈良訪問看護ステーション', 'g');
    new_services := regexp_replace(new_services, '[○〇◯]+訪問リハ[ビリテーション]*', '奈良リハビリセンター', 'g');
    new_services := regexp_replace(new_services, '[△▲○〇◯]+福祉用具[サービス]*', '奈良福祉用具サービス', 'g');
    new_services := regexp_replace(new_services, '[○〇◯]+デイケア[センタ・ー]*', '生駒デイケアセンター', 'g');
    new_services := regexp_replace(new_services, '[○〇◯]+ショートステイ', '奈良ショートステイひまわり', 'g');
    new_services := regexp_replace(new_services, '[○〇◯]+居宅介護支援[センタ・ー]*', '奈良居宅介護支援センター', 'g');

    IF new_services != rec.services_in_use::text THEN
      UPDATE kaigo_emergency_sheets SET services_in_use = new_services::jsonb WHERE id = rec.id;
    END IF;
  END LOOP;
END $$;

-- ===== kaigo_care_plan_services.provider / service_content =====
UPDATE kaigo_care_plan_services
SET provider = regexp_replace(provider, '[○〇◯]+デイサービス[センタ・ー]*', '奈良デイサービスセンター', 'g')
WHERE provider ~ '[○〇◯]+デイサービス';
UPDATE kaigo_care_plan_services
SET provider = regexp_replace(provider, '[○〇◯]+訪問介護[ステーション]*', '奈良訪問介護ステーション', 'g')
WHERE provider ~ '[○〇◯]+訪問介護';
UPDATE kaigo_care_plan_services
SET provider = regexp_replace(provider, '[○〇◯]+訪問看護[ステーション]*', '奈良訪問看護ステーション', 'g')
WHERE provider ~ '[○〇◯]+訪問看護';
UPDATE kaigo_care_plan_services
SET provider = regexp_replace(provider, '[○〇◯]+訪問リハ[ビリテーション]*', '奈良リハビリセンター', 'g')
WHERE provider ~ '[○〇◯]+訪問リハ';
UPDATE kaigo_care_plan_services
SET provider = regexp_replace(provider, '[△▲○〇◯]+福祉用具[サービス]*', '奈良福祉用具サービス', 'g')
WHERE provider ~ '[△▲○〇◯]+福祉用具';
UPDATE kaigo_care_plan_services
SET provider = regexp_replace(provider, '[○〇◯]+デイケア[センタ・ー]*', '生駒デイケアセンター', 'g')
WHERE provider ~ '[○〇◯]+デイケア';
UPDATE kaigo_care_plan_services
SET provider = regexp_replace(provider, '[○〇◯]+ショートステイ', '奈良ショートステイひまわり', 'g')
WHERE provider ~ '[○〇◯]+ショートステイ';
UPDATE kaigo_care_plan_services
SET provider = regexp_replace(provider, '[○〇◯]+居宅介護支援[センタ・ー]*', '奈良居宅介護支援センター', 'g')
WHERE provider ~ '[○〇◯]+居宅介護支援';

UPDATE kaigo_care_plan_services
SET service_content = regexp_replace(service_content, '[○〇◯]+デイサービス[センタ・ー]*', '奈良デイサービスセンター', 'g')
WHERE service_content ~ '[○〇◯]+デイサービス';
UPDATE kaigo_care_plan_services
SET service_content = regexp_replace(service_content, '[○〇◯]+訪問介護[ステーション]*', '奈良訪問介護ステーション', 'g')
WHERE service_content ~ '[○〇◯]+訪問介護';
UPDATE kaigo_care_plan_services
SET service_content = regexp_replace(service_content, '[△▲○〇◯]+福祉用具[サービス]*', '奈良福祉用具サービス', 'g')
WHERE service_content ~ '[△▲○〇◯]+福祉用具';

-- ===== kaigo_medical_history.hospital =====
UPDATE kaigo_medical_history
SET hospital = regexp_replace(hospital, '[○〇◯]+(病院|クリニック)', '奈良在宅医療クリニック', 'g')
WHERE hospital ~ '[○〇◯]+';

-- ===== kaigo_hospitalizations.hospital_name =====
UPDATE kaigo_hospitalizations
SET hospital_name = regexp_replace(hospital_name, '[○〇◯]+(病院|クリニック)', '奈良在宅医療クリニック', 'g')
WHERE hospital_name ~ '[○〇◯]+';

-- ===== emergency_sheets の主治医フィールド =====
UPDATE kaigo_emergency_sheets
SET doctor_hospital = regexp_replace(doctor_hospital, '[○〇◯]+(病院|クリニック)', '奈良在宅医療クリニック', 'g')
WHERE doctor_hospital ~ '[○〇◯]+';
UPDATE kaigo_emergency_sheets
SET doctor2_hospital = regexp_replace(doctor2_hospital, '[○〇◯]+(病院|クリニック)', '奈良在宅医療クリニック', 'g')
WHERE doctor2_hospital ~ '[○〇◯]+';
