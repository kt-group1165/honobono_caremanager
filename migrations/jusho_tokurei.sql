-- ============================================================================
-- 住所地特例 (総合事業 71R1 明細情報(住所地特例) 種別14 レコード用) (2026-07-13)
-- ============================================================================
-- 背景:
--   介護予防・日常生活支援総合事業費請求明細書 (交換情報識別番号 71R1 / 様式第二の三) では、
--   住所地特例対象者の明細行を「明細情報レコード (種別02)」ではなく
--   「明細情報(住所地特例)レコード (種別14)」で出力する
--   (国保中央会 IF仕様書 サービス事業所編 R5.4版。種別14 は全19項目で、
--    項番18 = 施設所在保険者番号 (数字6桁) =「住所地特例対象者が入所（居）する
--    施設の所在する市町村の証記載保険者番号」)。
--
-- 設計:
--   - 住所地特例は「利用者単位の属性」(事業所の所在地ではない) なので clients に持つ。
--     * jusho_tokurei                 : 住所地特例対象者フラグ
--     * jusho_tokurei_insurer_number  : 施設所在保険者番号 (数字6桁。種別14 項番18)
--   - UI = kaigo-app 利用者詳細 > 介護認定タブ。伝送 = build-sougou.ts が
--     フラグ true かつ番号 6桁のとき種別14、番号未設定時は warning + 種別02 (安全側)。
--
-- 冪等: 何度流しても安全 (ADD COLUMN IF NOT EXISTS)。
-- Supabase SQL Editor に BEGIN〜COMMIT ごと貼って Run すること。

BEGIN;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS jusho_tokurei BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS jusho_tokurei_insurer_number TEXT;

COMMENT ON COLUMN clients.jusho_tokurei IS
  '住所地特例対象者。総合事業伝送 (71R1) の明細を種別14 (明細情報(住所地特例)) で出力する';
COMMENT ON COLUMN clients.jusho_tokurei_insurer_number IS
  '施設所在保険者番号 (数字6桁)。住所地特例対象者が入所(居)する施設の所在する市町村の証記載保険者番号 (種別14 項番18)。被保険者証の保険者番号 (保険者=元の市町村) とは別';

COMMIT;
