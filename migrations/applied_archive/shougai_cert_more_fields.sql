-- ============================================================================
-- 障害福祉: 受給者証入力を ほのぼのMORE 相当まで拡張 (2026-07-14)
-- ============================================================================
-- 追加のみ・冪等 (IF NOT EXISTS)。既存の請求/伝送ロジックには影響しない。
-- 交付年月日 / 申請中 / 所得区分 / 各種軽減・減免フラグ / 事業者記入欄 (予備欄) /
-- 支給量の時間・回内訳 を受給者証 (shougai_certifications) に追加する。
--
-- 列名は請求側エージェントが参照するため固定。
--   flag_special_area は請求で特別地域加算 (%) の判定に使われる。

BEGIN;

ALTER TABLE shougai_certifications
  ADD COLUMN IF NOT EXISTS issue_date DATE,
  ADD COLUMN IF NOT EXISTS is_applying BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS income_category TEXT,
  ADD COLUMN IF NOT EXISTS shafuku_genmen BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reduced_payment_limit INTEGER,
  ADD COLUMN IF NOT EXISTS municipality_defined_amount INTEGER,
  ADD COLUMN IF NOT EXISTS household_multi_jogen BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS flag_rousha BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS flag_h30_after BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS flag_severe BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS flag_short_multi BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS flag_special_area BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS provider_entries JSONB,
  ADD COLUMN IF NOT EXISTS shikyuryo_details JSONB;

COMMENT ON COLUMN shougai_certifications.issue_date IS '受給者証の交付年月日';
COMMENT ON COLUMN shougai_certifications.is_applying IS '申請中 (受給者証未交付・申請段階)';
COMMENT ON COLUMN shougai_certifications.income_category IS '所得区分 (生活保護 / 低所得1 / 低所得2 / 一般1 / 一般2)';
COMMENT ON COLUMN shougai_certifications.shafuku_genmen IS '社会福祉法人による利用者負担軽減';
COMMENT ON COLUMN shougai_certifications.reduced_payment_limit IS '利用者負担軽減後の上限月額 (円)';
COMMENT ON COLUMN shougai_certifications.municipality_defined_amount IS '市町村が定める額 (円)';
COMMENT ON COLUMN shougai_certifications.household_multi_jogen IS '同一世帯の複数利用者で上限管理を行う';
COMMENT ON COLUMN shougai_certifications.flag_rousha IS '聾者 (同行援護 等の判定用)';
COMMENT ON COLUMN shougai_certifications.flag_h30_after IS 'H30.4 以降の支給決定';
COMMENT ON COLUMN shougai_certifications.flag_severe IS '著しく重度の者';
COMMENT ON COLUMN shougai_certifications.flag_short_multi IS '短時間の複数回訪問';
COMMENT ON COLUMN shougai_certifications.flag_special_area IS '特別地域加算 (請求に % 加算が乗る)';
COMMENT ON COLUMN shougai_certifications.provider_entries IS '事業者記入欄 (予備欄。最大6枠) [{no,label,value}]';
COMMENT ON COLUMN shougai_certifications.shikyuryo_details IS '支給量の時間/回内訳 {key:{hours,minutes}|{count}|{units}}';

COMMIT;
