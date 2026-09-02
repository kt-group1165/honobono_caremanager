-- 【未実行・user判断待ち】旧世代 kaigo_service_codes (総合事業) の削除
--
--   対象: system='総合事業' のうち、valid_until が NULL でも '2999-12-31' でもなく、
--   かつ「当システムに存在する最古のトランザクションデータ (kaigo_visit_addon_lines.
--   target_month = 2025-06)」より前に完全に世代が閉じているもの。
--   このシステムが一度もこの世代を参照しえなかったことになる。
--
--   実測 (2026-09-02、K確認): 総合事業3,496件中 1,049件が該当 (30%)。
--   介護/障害/地域生活支援/独自は同条件で0件 (元々世代数が少なく現行世代と重なる)。
--   distinct service_code 765種類のうち746種類は現行世代(valid_until null/2999-12-31)
--   自体を持たない = 市区町村の制度改定で完全に廃止されたコード体系がほとんど。
--
--   FK参照: 無し。service_codeは`lib/service-code-valid.ts`のvalidInMonth()で
--   コード文字列+日付から都度動的に引く設計で、IDでの外部キー参照は
--   モノレポ全体をgrep(`service_code_id`)しても0件、REFERENCES制約も無い。
--   よって削除しても参照整合性は壊れない。
--
--   ⚠ ただし「本当に削除してよいか」はuser判断が要る (I調査時からの申し送り)。
--   このシステム自体が2025-06以前のデータを持たないだけで、総合事業の告示自体は
--   もっと古くから存在するため、過去月の外部監査等で必要になる可能性はゼロではない。
--   **--executeはしていない。dry-runの確認結果として提示する。**
--
-- 実行する場合の手順 (この順で1ブロックとしてSupabase SQL Editorで実行):
BEGIN;

-- ① backup (削除前に必ず取る)
CREATE TABLE _backup_kaigo_service_codes_sougou_legacy_20260902 AS
SELECT * FROM kaigo_service_codes
WHERE system = '総合事業'
  AND valid_until IS NOT NULL
  AND valid_until <> '2999-12-31'
  AND valid_until < '2025-06-01';

-- ② 件数確認 (1049件になっているはず。ズレていたら DELETE の前に一旦止めて確認すること)
-- SELECT count(*) FROM _backup_kaigo_service_codes_sougou_legacy_20260902;

-- ③ 削除
DELETE FROM kaigo_service_codes
WHERE system = '総合事業'
  AND valid_until IS NOT NULL
  AND valid_until <> '2999-12-31'
  AND valid_until < '2025-06-01';

COMMIT;
