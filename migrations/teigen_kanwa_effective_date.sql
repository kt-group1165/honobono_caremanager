-- ─────────────────────────────────────────────────────────────────────────────
-- 逓減制の緩和要件フラグを bool → 適用開始日 (date) に置き換える。
--
--   背景: offices.teigen_kanwa は bool で「該当する/しない」の一点しか
--   表現できない。ケアプランデータ連携システムへの登録は事業所ごとに時期が違うため、
--   過去分のレセプトを正しく再現するには「いつから該当したか」が要る。
--   現状 teigen_kanwa は全事業所 false (未判定) なので、置き換えても実害はない。
--
--   offices.teigen_kanwa (boolean) を DROP し、
--   offices.teigen_kanwa_from (date, NULL可) を ADD する。
--     NULL          = 緩和要件に該当しない (居宅介護支援費(Ⅰ)。45件で逓減)
--     日付が入っている = その月以降、緩和要件に該当 (居宅介護支援費(Ⅱ)。50件で逓減)
--                      判定は「対象月の1日 >= この日付」で行う。
--
--   参照側 (kaigo-app):
--     - /master/office   設定 UI (要件説明 + 適用開始日入力)
--     - claims-shared.ts fetchTeigenSettings(supabase, officeId, targetMonth)
--
--   Supabase SQL Editor に本ブロックをそのまま貼って Run (COMMIT まで含める)。
--   適用後は migrations/applied_archive/ へ移動すること。
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

ALTER TABLE offices
  DROP COLUMN IF EXISTS teigen_kanwa,
  ADD COLUMN IF NOT EXISTS teigen_kanwa_from date;

COMMENT ON COLUMN offices.teigen_kanwa_from IS
  '逓減制の緩和要件 (ケアプランデータ連携システムに登録・事務職員配置 = 居宅介護支援費(Ⅱ)体制)
   に該当し始めた月の1日。NULL = 非該当 (Ⅰ体制・45件で逓減)。
   対象月の1日がこの日付以降なら該当 (Ⅱ体制・50件で逓減)。';

COMMIT;
