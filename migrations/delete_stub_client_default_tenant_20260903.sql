-- clients テーブルの壊れたスタブ行(tenant_id='default')を削除する。
--
-- 背景 (2026-09-02 事業所マスタ改善調査、equipment_masterのtenant_id='default'是正の
-- 横展開調査で発覚):
--   clients 全9,097件のうち1件だけ tenant_id='default' になっていた(他は全てkt-group)。
--   id: 094f6b15-19fb-45f8-a819-e4c765fb83d1
--   name: "鈴木" (姓のみ・不完全) / user_number: "1" / internal_number: 10002
--   住所・電話・office_id・care_office_id・保険者番号など、ほぼ全列がNULL。
--   status='active' (論理削除もされていない)。
--   client_office_assignments / kaigo_visit_schedule / kaigo_care_plans /
--   kaigo_support_records / kaigo_assessments のいずれにも紐づくレコード0件。
--
-- office_idがNULLのため「自事業所」タブには出ず実害は限定的だが、
-- 動作確認用の作りかけデータと見られ、関連レコードが無いため
-- CLAUDE.mdの「stubより削除」方針に従い削除する。
--
-- Supabase SQL Editor で BEGIN〜COMMIT を1ブロックとして貼って実行してください。

BEGIN;

-- 削除前にbackup (念のため)
CREATE TABLE IF NOT EXISTS public._backup_clients_stub_default_20260903 AS
SELECT * FROM public.clients
WHERE id = '094f6b15-19fb-45f8-a819-e4c765fb83d1';

ALTER TABLE public._backup_clients_stub_default_20260903 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public._backup_clients_stub_default_20260903 FORCE ROW LEVEL SECURITY;

-- 関連レコードが0件であることを再確認 (0件でなければここで止めて手動確認すること)
SELECT
  (SELECT count(*) FROM client_office_assignments WHERE client_id = '094f6b15-19fb-45f8-a819-e4c765fb83d1') AS office_assignments,
  (SELECT count(*) FROM kaigo_visit_schedule WHERE user_id = '094f6b15-19fb-45f8-a819-e4c765fb83d1') AS visit_schedule,
  (SELECT count(*) FROM kaigo_care_plans WHERE user_id = '094f6b15-19fb-45f8-a819-e4c765fb83d1') AS care_plans,
  (SELECT count(*) FROM kaigo_support_records WHERE user_id = '094f6b15-19fb-45f8-a819-e4c765fb83d1') AS support_records,
  (SELECT count(*) FROM kaigo_assessments WHERE user_id = '094f6b15-19fb-45f8-a819-e4c765fb83d1') AS assessments;

DELETE FROM public.clients WHERE id = '094f6b15-19fb-45f8-a819-e4c765fb83d1';

COMMIT;

-- 確認用 (Editorで別途流す。上のCOMMIT後に):
-- SELECT count(*) FROM public.clients WHERE tenant_id = 'default'; -- 0件になればOK
