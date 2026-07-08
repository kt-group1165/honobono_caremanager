-- 訪問介護 同一建物減算 (令和6年度〜)
-- client_office_assignments に同一建物区分を持たせる。
--   null = 減算なし / '1' = 減算1(10%) / '2' = 減算2(15%) / '3' = 減算3(12%)
-- 利用者×事業所単位の属性。同一建物区分は事業所ごとに異なりうるため junction に持つ。
--
-- 適用は Supabase SQL Editor で 1 ブロック貼付 → Run (BEGIN;...COMMIT;)。
BEGIN;

ALTER TABLE client_office_assignments
  ADD COLUMN IF NOT EXISTS same_building_tier text
    CHECK (same_building_tier IN ('1', '2', '3'));

COMMENT ON COLUMN client_office_assignments.same_building_tier IS
  '訪問介護 同一建物減算区分。null=減算なし / 1=減算1(10%) / 2=減算2(15%) / 3=減算3(12%)。所定単位数に対する%減算。';

COMMIT;
