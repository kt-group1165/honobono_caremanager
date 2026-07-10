-- bath_billing_status を kaigo_billing_status と列・制約一致させる
-- (訪問入浴の請求4タブ流用で、kaigo-seikyu の select("...notes") と
--  upsert onConflict "client_id,target_month,office_id" に合わせる)
-- Phase: 訪問入浴 請求4タブ hotfix (2026-07-09)
--
-- 症状: 介護請求タブで bath_billing_status への select が notes 列不在で 400。

BEGIN;

-- notes 列追加 (kaigo_billing_status に存在)
ALTER TABLE bath_billing_status ADD COLUMN IF NOT EXISTS notes TEXT;

-- UNIQUE を (client_id, target_month) → (client_id, target_month, office_id) へ
-- (upsert onConflict "client_id,target_month,office_id" に対応)
ALTER TABLE bath_billing_status DROP CONSTRAINT IF EXISTS bath_billing_status_client_id_target_month_key;
ALTER TABLE bath_billing_status ADD CONSTRAINT bath_billing_status_ctmo_key UNIQUE (client_id, target_month, office_id);

COMMIT;
