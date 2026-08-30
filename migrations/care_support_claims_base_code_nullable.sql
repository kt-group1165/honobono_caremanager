-- ============================================================================
-- 居宅レセプトの「基本コード無し」を許す
--
-- ── なぜ ────────────────────────────────────────────────────────────────
--   月の途中で亡くなった利用者は **給付管理をしない**ので 居宅介護支援費
--   (432xxx) が立たない。それでも **ターミナルケアマネジメント加算 400単位**
--   だけは請求する。この形のレセプトが実在する。
--
--     ＫＴ在宅サポートセンター  122192|1000101762  2026-06
--       436100 居宅支援ターミナルケアマネジメント加算  400単位
--       436191 居宅支援処遇改善加算                      8単位
--       ────────────────────────────────  408単位 = 4,365円
--
--   care_support_code / care_support_name が NOT NULL だと **この 1 枚が
--   丸ごと取り込めず**、事業所合計が 4,365 円足りなくなる。
--
--   コード側は billing/forms と billing/seikyu で
--   「基本コードが無いときは明細の基本行を出さない」よう対応済み。
--
-- 実行: Supabase SQL Editor に貼って Run
-- ============================================================================
BEGIN;

ALTER TABLE kaigo_care_support_claims ALTER COLUMN care_support_code DROP NOT NULL;
ALTER TABLE kaigo_care_support_claims ALTER COLUMN care_support_name DROP NOT NULL;

COMMENT ON COLUMN kaigo_care_support_claims.care_support_code IS
  '居宅介護支援費のサービスコード。⚠ NULL 可 = 給付管理をしない月 (死亡等) で加算のみ請求するケース';

COMMIT;
