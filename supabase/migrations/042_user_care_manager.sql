-- 042: 利用者に担当ケアマネージャー列を追加

ALTER TABLE kaigo_users ADD COLUMN IF NOT EXISTS care_manager_staff_id UUID REFERENCES kaigo_staff(id);
CREATE INDEX IF NOT EXISTS idx_kaigo_users_care_manager ON kaigo_users(care_manager_staff_id);
