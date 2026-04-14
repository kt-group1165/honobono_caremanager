-- 038: 緊急時シートテーブル
CREATE TABLE IF NOT EXISTS kaigo_emergency_sheets (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id) ON DELETE CASCADE,
  -- 基本情報（利用者テーブルから自動取得するが、緊急時シート固有の情報も保存）
  blood_type TEXT,                    -- 血液型
  allergies TEXT,                     -- アレルギー
  -- かかりつけ医
  doctor_name TEXT,                   -- 主治医名
  doctor_hospital TEXT,               -- 医療機関名
  doctor_phone TEXT,                  -- 医療機関電話
  doctor_address TEXT,                -- 医療機関住所
  -- かかりつけ医2
  doctor2_name TEXT,
  doctor2_hospital TEXT,
  doctor2_phone TEXT,
  -- かかりつけ歯科
  dentist_name TEXT,
  dentist_hospital TEXT,
  dentist_phone TEXT,
  -- かかりつけ薬局
  pharmacy_name TEXT,
  pharmacy_phone TEXT,
  -- 緊急連絡先1
  emergency_contact1_name TEXT,
  emergency_contact1_relation TEXT,   -- 続柄
  emergency_contact1_phone TEXT,
  emergency_contact1_address TEXT,
  -- 緊急連絡先2
  emergency_contact2_name TEXT,
  emergency_contact2_relation TEXT,
  emergency_contact2_phone TEXT,
  emergency_contact2_address TEXT,
  -- 緊急連絡先3
  emergency_contact3_name TEXT,
  emergency_contact3_relation TEXT,
  emergency_contact3_phone TEXT,
  -- 既往歴・現病歴
  medical_history TEXT,               -- 既往歴
  current_illness TEXT,               -- 現病歴
  -- ADL
  adl_mobility TEXT,                  -- 移動
  adl_eating TEXT,                    -- 食事
  adl_toileting TEXT,                 -- 排泄
  adl_bathing TEXT,                   -- 入浴
  adl_dressing TEXT,                  -- 更衣
  adl_communication TEXT,             -- コミュニケーション
  adl_cognition TEXT,                 -- 認知
  adl_notes TEXT,                     -- ADL備考
  -- 服薬情報
  medications TEXT,                   -- 服薬一覧
  medication_notes TEXT,              -- 服薬上の注意
  -- 緊急時対応
  emergency_instructions TEXT,        -- 緊急時の対応方法
  hospital_preference TEXT,           -- 搬送先希望病院
  -- ケアマネ情報
  care_manager_name TEXT,
  care_manager_office TEXT,
  care_manager_phone TEXT,
  -- その他
  notes TEXT,                         -- 備考
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)  -- 1利用者につき1シート
);

CREATE TRIGGER update_kaigo_emergency_sheets_updated_at BEFORE UPDATE ON kaigo_emergency_sheets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE kaigo_emergency_sheets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_all" ON kaigo_emergency_sheets FOR ALL TO authenticated USING (true) WITH CHECK (true);
