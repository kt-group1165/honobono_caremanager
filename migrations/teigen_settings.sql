-- ─────────────────────────────────────────────────────────────────────────────
-- 居宅介護支援費 逓減制 (令和6年度〜) の自動判定用 事業所設定
--
--   offices に 2 列追加:
--     caremane_jokin_kansan : 介護支援専門員の常勤換算数 (NULL/0 = 自動判定しない)
--     teigen_kanwa          : 逓減制の緩和要件 (ICT活用・事務職員配置
--                             = 居宅介護支援費(Ⅱ)体制) に該当するか
--
--   参照側 (kaigo-app):
--     - /master/office        設定 UI (列未適用でも本体保存は成功する分離 UPDATE)
--     - /billing/claims       一括生成の tier 自動判定 (fetchTeigenSettings)
--     - /billing/seikyu       判定結果バナー
--   列未適用の間はコードが従来動作 (45件警告のみ) にフォールバックする。
--
--   Supabase SQL Editor に本ブロックをそのまま貼って Run (COMMIT まで含める)。
--   適用後は migrations/applied_archive/ へ移動すること。
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

ALTER TABLE offices
  ADD COLUMN IF NOT EXISTS caremane_jokin_kansan numeric(5,2),
  ADD COLUMN IF NOT EXISTS teigen_kanwa boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN offices.caremane_jokin_kansan IS
  '介護支援専門員の常勤換算数 (居宅介護支援 逓減制の自動判定用。NULL/0 = 判定しない)';
COMMENT ON COLUMN offices.teigen_kanwa IS
  '逓減制の緩和要件 (ICT活用・事務職員配置 = 居宅介護支援費(Ⅱ)体制) 該当';

COMMIT;
