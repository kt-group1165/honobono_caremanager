-- ============================================================================
-- offices.tokutei_kassan_type: 旧区分 (A/B/C) → 新区分 (Ⅰ/Ⅱ/Ⅲ) 移行 + CHECK 更新
-- ============================================================================
-- 旧 CHECK は ('なし','A','B','C') のみ許可で、画面 (令和6年度表記の
-- なし/Ⅰ/Ⅱ/Ⅲ/A) からの保存が
--   violates check constraint "offices_tokutei_kassan_type_check"
-- で失敗していた。既存 16 事業所の 'B' を 'Ⅱ' へ表記移行し、CHECK を
-- 新表記に更新する。
--
-- 注意: tokutei_kassan_units は変更しない (旧 B 事業所は 0 のまま)。
--       単位数を令和6年度の値にするかは各事業所画面で選び直して保存する。
--       移行後の 'A' は令和6年度の特定事業所加算(A) (114単位) を意味する。

BEGIN;

UPDATE offices SET tokutei_kassan_type = 'Ⅰ' WHERE tokutei_kassan_type = 'A';
UPDATE offices SET tokutei_kassan_type = 'Ⅱ' WHERE tokutei_kassan_type = 'B';
UPDATE offices SET tokutei_kassan_type = 'Ⅲ' WHERE tokutei_kassan_type = 'C';

ALTER TABLE offices DROP CONSTRAINT offices_tokutei_kassan_type_check;
ALTER TABLE offices ADD CONSTRAINT offices_tokutei_kassan_type_check
  CHECK (tokutei_kassan_type IN ('なし', 'Ⅰ', 'Ⅱ', 'Ⅲ', 'A'));

COMMIT;
