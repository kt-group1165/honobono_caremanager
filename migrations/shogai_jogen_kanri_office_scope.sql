-- apps/kaigo-app/migrations/shogai_jogen_kanri_office_scope.sql
-- 2026-09-01 監査是正: 上限額管理結果に事業所の軸が無く、兼務利用者で過大請求になる。
--
-- 【何が起きるか】
--   利用者負担上限額管理結果票は **関係事業所ごとに決定額が違う**。
--   ところが shogai_jogen_kanri_results は UNIQUE (client_id, target_month) で
--   1 利用者 1 か月につき 1 行しか持てない。
--   列コメントは「管理結果後の**当事業所分** 利用者負担額」と書いてあるのに、
--   どの事業所の分なのかを保持していない。
--
--   → 同じ利用者を当社の複数事業所で見ている場合、全事業所が同じ
--     kanri_result_amount を利用者負担として使う = 差額が市への過大請求になる。
--
-- 【実測 2026-09-01 の該当者 (2026-06 有効証 × 複数事業所割当)】
--   前田 健司     他事業所  ＫＴ姉崎 / ちはら台 / ＫＴやわた / 市原ムツミ
--   中村 雪枝     他事業所  中央 / おゆみ野 / Ｈａｎａ居宅支援センターおゆみ野
--   清水 日出男   他事業所  中央 / おゆみ野
--   谷口 陽亮     他事業所  花見川 / 高品
--   黒田 緑       他事業所  大網白里 / 山武
--   鵜澤 あや子   自事業所  花見川 / さつきが丘
--   西 協子       自事業所  中央 / おゆみ野
--
--   ⚠ 引き継ぎ書の「前田健司は 3 拠点にまたがる。1 件入れれば 3 拠点改善」は
--     **この設計では成立しない** (1 行しか持てないので 3 拠点に同じ額が入るだけ)。
--
-- 【この migration がやること】
--   ・office_id 列を追加 (関係事業所 = 当社側で請求する事業所)
--   ・一意キーを (client_id, target_month, office_id) に広げる
--   ・既存 13 行は office_id NULL のまま残す。NULL 同士の重複を防ぐため
--     部分 UNIQUE INDEX で従来のキーも維持する (後方互換)
--   ・RLS が `USING (true) TO authenticated` の全開だったので tenant scope 化
--
--   ※ office_lines (自事業所が管理者のとき J41 に出す関係事業所行) は
--     従来どおり「管理する側」の 1 行に持たせる。今回は触らない。
--
-- 【アプリ側】
--   同 commit のコードで
--     ・集計 (shogai-seikyu/aggregate.ts) は office_id 一致を優先し、
--       無ければ NULL 行にフォールバック (既存データの挙動を変えない)
--     ・保存 (shogai-seikyu-content.tsx) は office_id を入れて upsert
--   に変えている。**この SQL を先に適用すること** (列が無いと保存が 42703 で落ちる)。

BEGIN;

DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM user_groups ug
    JOIN auth.users u ON u.id = ug.user_id
   WHERE u.email = 'domen@kt-group.co.jp' AND ug.role = 'group_admin';
  IF v_count = 0 THEN
    RAISE EXCEPTION '安全弁失敗: group_admin domen が居ないので適用中止';
  END IF;
END $$;

DROP TABLE IF EXISTS _backup_shogai_jogen_kanri_20260901;
CREATE TABLE _backup_shogai_jogen_kanri_20260901 AS
  SELECT * FROM shogai_jogen_kanri_results;

-- ① office_id 列
ALTER TABLE shogai_jogen_kanri_results
  ADD COLUMN IF NOT EXISTS office_id UUID REFERENCES offices(id);

COMMENT ON COLUMN shogai_jogen_kanri_results.office_id IS
  '関係事業所 (この管理結果が適用される当社側の事業所)。'
  ' 上限額管理結果票は関係事業所ごとに決定額が違うため必須。'
  ' NULL = 2026-09-01 の列追加前からある行 (どの事業所か不明)。';

-- ② 一意キーを広げる (旧キーは NULL 行のために部分 index で残す)
ALTER TABLE shogai_jogen_kanri_results
  DROP CONSTRAINT IF EXISTS shogai_jogen_kanri_results_client_id_target_month_key;

CREATE UNIQUE INDEX IF NOT EXISTS shogai_jogen_kanri_client_month_office_key
  ON shogai_jogen_kanri_results (client_id, target_month, office_id)
  WHERE office_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS shogai_jogen_kanri_client_month_nulloffice_key
  ON shogai_jogen_kanri_results (client_id, target_month)
  WHERE office_id IS NULL;

-- ③ RLS: `USING (true)` 全開だったので tenant scope 化
ALTER TABLE shogai_jogen_kanri_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shogai_jogen_kanri_results_all ON shogai_jogen_kanri_results;
DROP POLICY IF EXISTS shogai_jogen_kanri_results_authenticated ON shogai_jogen_kanri_results;
CREATE POLICY shogai_jogen_kanri_results_authenticated ON shogai_jogen_kanri_results
  FOR ALL TO authenticated
  USING      (tenant_id IN (SELECT auth_visible_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT auth_visible_tenant_ids()));

-- ④ 検証
DO $$
DECLARE v_n INT; v_null INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='shogai_jogen_kanri_results'
       AND column_name='office_id'
  ) THEN
    RAISE EXCEPTION '検証失敗: office_id 列が無い';
  END IF;
  SELECT COUNT(*) INTO v_n FROM shogai_jogen_kanri_results;
  SELECT COUNT(*) INTO v_null FROM shogai_jogen_kanri_results WHERE office_id IS NULL;
  RAISE NOTICE '✓ office_id 追加 (全 % 行 / うち NULL % 行 = 列追加前の既存分)', v_n, v_null;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='shogai_jogen_kanri_results'
       AND policyname='shogai_jogen_kanri_results_authenticated'
  ) THEN
    RAISE EXCEPTION '検証失敗: RLS policy が作られていない';
  END IF;
  RAISE NOTICE '✓ RLS を tenant scope 化しました';
END $$;

COMMIT;

-- ロールバック:
--   DROP INDEX IF EXISTS shogai_jogen_kanri_client_month_office_key;
--   DROP INDEX IF EXISTS shogai_jogen_kanri_client_month_nulloffice_key;
--   ALTER TABLE shogai_jogen_kanri_results DROP COLUMN IF EXISTS office_id;
--   ALTER TABLE shogai_jogen_kanri_results
--     ADD CONSTRAINT shogai_jogen_kanri_results_client_id_target_month_key
--     UNIQUE (client_id, target_month);
--   (行そのものは _backup_shogai_jogen_kanri_20260901 に退避済)
