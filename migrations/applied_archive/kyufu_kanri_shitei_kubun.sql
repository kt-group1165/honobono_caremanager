-- 給付管理 (kaigo_benefit_management) に 8222 項18
-- 「指定/基準該当/地域密着型サービス識別コード」を保持する列を追加。
--
-- 背景 (2026-07-29): おゆみ野・大網の K vs KY 照合で、地域密着型サービス
-- (種類72/76/77/78) の明細行が 新=1 / ほのぼの=5 で不一致だった。
-- 共通編 1.4 項26: 1=指定 / 2=基準該当 / 3=相当サービス / 4=その他 /
-- 5=地域密着型 / 6=混在型Ⅰ / 7=混在型Ⅱ / 8=総合事業(経過措置) / 9=総合事業。
-- 地域密着型 (71〜78→5) は種類コードから導出できるが、基準該当 (袖ケ浦の
-- 短期入所3行=区分2) や混在型 (K姉 A2=区分6) は事業所固有で導出不能のため、
-- KY取込 (import_kyotaku_benefit_from_ky.mjs) で実値を保持する。
-- NULL の場合 builder (build-kyotaku.ts shiteiKubunOf) が種類コードから導出。
BEGIN;

ALTER TABLE kaigo_benefit_management
  ADD COLUMN IF NOT EXISTS shitei_kubun text;

COMMENT ON COLUMN kaigo_benefit_management.shitei_kubun IS
  '8222項18 指定/基準該当/地域密着型サービス識別コード (1=指定/2=基準該当/5=地域密着型 等)。NULLは種類コードから導出';

COMMIT;
