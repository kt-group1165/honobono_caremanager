-- =====================================================================
-- offices.shogai_business_number 列追加 — 障害福祉の指定事業所番号
-- =====================================================================
-- 背景:
--   障害の国保連伝送 (J11/J61/J41) のエンベロープ・全レコードに出す
--   事業所番号は、介護の指定事業所番号 (offices.business_number,
--   茂原 = 1271500942) ではなく、別に交付される障害福祉の指定事業所番号
--   (茂原 = 1213100017)。
--   現状 app が business_number をそのまま officeNumber に渡すため、
--   障害伝送に介護番号が出て返戻になっていた。
--   障害番号を別カラムで保持し、障害伝送時のみ優先採用する。
--
-- 影響範囲: 障害伝送 (J11/J61/J41) の事業所番号のみ。
--   - business_number (介護の番号) は不変
--   - shogai_business_number 未設定 (NULL) の office は
--     app 側で business_number にフォールバック → 既存挙動維持
--
-- 適用: Supabase SQL Editor に貼って Run (DDL のためユーザが適用)
-- 実績: 茂原 (リンクスヘルパーステーション) 1 件に backfill
--   e08c3706 リンクスヘルパーステーション → 1213100017
-- =====================================================================

BEGIN;

-- ① 障害事業所番号 列追加 (nullable)
ALTER TABLE offices ADD COLUMN IF NOT EXISTS shogai_business_number TEXT;

COMMENT ON COLUMN offices.shogai_business_number IS
  '障害福祉の指定事業所番号。障害伝送 (J11/J61/J41) のエンベロープ/レコードに使用。未設定時は business_number にフォールバック';

-- ② 茂原 (リンクスヘルパーステーション) に障害事業所番号を backfill
UPDATE offices
   SET shogai_business_number = '1213100017'
 WHERE id = 'e08c3706-ad59-4913-b4e2-67f2675422e9';

-- ③ 反映確認 (実績 1 件)
SELECT id, name, business_number, shogai_business_number
  FROM offices
 WHERE shogai_business_number IS NOT NULL;

COMMIT;

-- =====================================================================
-- 将来追加するには:
--   UPDATE offices SET shogai_business_number = '<13桁>' WHERE id = '<uuid>';
-- =====================================================================
