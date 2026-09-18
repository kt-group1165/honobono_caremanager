-- ############################################################################
-- ## ⚠ これは **未適用** です。実行が要ります。                              ##
-- ############################################################################
--
-- 2026-09-03 に DB を実物で照合して判明:
--   applied_archive/ に置かれていたが **offices.contract_overrides 列は存在しない**。
--   commit f9ce8af (2026-07-01) のメッセージにも「DB (要 apply)」とあり、
--   SQL は最初から applied_archive/ に **新規作成** されていた (移動ではない)。
--   = 適用待ちと分かる場所に一度も置かれず、実行されないまま「適用済」扱いになっていた。
--
-- 影響: /user-contracts/[id] が offices をこの列込みで取るため、列が無いと
--   42703 で事業所情報が丸ごと null になり、**契約書が事業所名・住所・電話・
--   管理者すべて空欄のまま印字される**。error を握りつぶしていたので黙って起きる。
--   → error の check は先に入れた (同 commit)。この SQL を適用すると機能が動く。
--
-- ⚠ 適用したら applied_archive/ へ移すこと。
--
-- 参考: applied_archive の SQL 92 本 / ADD COLUMN 141 列を照合した結果、
--   列が無いのは 8 列。うち teigen_kanwa (teigen_settings.sql) と
--   service_category ×6 表 (phase_shougai_support.sql) は後継列に置き換わっていて
--   コードからも参照されない。**実害があるのはこの 1 本だけ。**
--
-- ============================================================================
-- offices.contract_overrides
--  = 事業所ごとに契約書テンプレの任意 key を上書き
--    (別紙7 苦情窓口 / 別紙1 相談窓口 / 職員体制 / 交通費 等、事業所固有の値)
-- ----------------------------------------------------------------------------
-- render 側の fallback 順:
--   contract.content[key] (=snapshot)
--   → office.contract_overrides[key]  ← このカラム
--   → active_template.content[key]
--   → defaults (types.ts)
-- ============================================================================

BEGIN;

ALTER TABLE offices
  ADD COLUMN IF NOT EXISTS contract_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
