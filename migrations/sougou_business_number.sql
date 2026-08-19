-- ============================================================================
-- offices.sougou_business_number — 総合事業の事業所番号
--
-- 総合事業 (介護予防・日常生活支援総合事業) は市町村ごとの指定なので、
-- **介護保険と別の事業所番号を持つ事業所がある**。
--   例) ちはら台: 介護 1272403534 / 総合 12A2400103 (英字を含む)
-- 番号が違うと 7113/71R1 が丸ごと別事業所の請求として扱われる。
--
-- 障害の shogai_business_number と同じ考え方 (制度ごとに別指定・別番号)。
-- NULL なら business_number (介護の番号) にフォールバックする。
-- 英字が入るので桁数チェックのみで CHECK は付けない (10 桁固定)。
-- ============================================================================
BEGIN;

ALTER TABLE offices ADD COLUMN IF NOT EXISTS sougou_business_number text;

COMMENT ON COLUMN offices.sougou_business_number IS
  '総合事業の事業所番号 (10桁・英字を含む場合あり)。NULL なら business_number を使う';

-- 実伝送 (KK260804 の 71R1) で確認済み
UPDATE offices SET sougou_business_number = '12A2400103'
WHERE id = 'fd0179ae-6a20-4bf2-9ab0-37d61c744f64';  -- ちはら台

COMMIT;
