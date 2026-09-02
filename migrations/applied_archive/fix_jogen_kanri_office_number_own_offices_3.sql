-- 【未実行・user確認後に実行】上限額管理事業所番号「自社らしい3件」の是正
--
--   対象は SESSION_START.md に記載の「自社らしい3件」
--     小倉 朋美 (ムツミHS) / 伊藤 大希 (さつきが丘（児童）) / 谷口 陽亮 (高品（身障）)
--
--   調査結果 (2026-09-03、K):
--   ①jogen_kanri_office_name はいずれも当方の実在office名とほぼ一致する。
--     小倉朋美: 「株式会社サービスワン　ムツミヘルパーステーション」
--       → companies に「株式会社 サービスワン」が実在(自社5法人の1つ)。
--         offices「ムツミヘルパーステーション」(shogai_business_number=1210600043)と一致。
--     谷口陽亮: 「Hanaヘルパーステーション高品（身障）」
--       → offices「Ｈａｎａヘルパーステーション高品」(shogai_business_number=1210102263)と一致。
--     伊藤大希: 「Ｈanaヘルパーステーションさつきが丘（児童）」
--       → offices「Ｈａｎａヘルパーステーションさつきが丘」(shogai_business_number=1210103394)と一致。
--   ②「（身障）」「（児童）」はほのぼの側のケース管理上の便宜表記とみられ、別法人格・
--     別事業所番号の証拠ではない。3件とも service_types は一貫して['居宅介護']のみ
--     (障害児居宅介護は障害者総合支援法の同一指定番号で行える。児童福祉法の別番号が
--     要るのは児童発達支援・放課後等デイサービス等の"施設系"サービスで、この3件には無い)。
--   ③ office_service_designations (追加指定を保持する専用テーブル) は全社的に0件で、
--     児童福祉法別番号を裏付ける材料はDB内に存在しない。
--   ④ 伊藤大希の認定は2022-02-28で失効済み(現在アクティブな認定なし)。今回の3件のうち
--     唯一、現行の請求には影響しない過去分。
--
--   結論: 別番号が必要という根拠は見当たらず、各officeの既存 shogai_business_number を
--   そのまま使ってよいと判断する。ただし100%の確証(受給者証原本での目視確認)ではないため、
--   実行前にuser確認を挟むこと。
BEGIN;

CREATE TABLE _backup_shougai_jogen_kanri_own_offices_20260903 AS
SELECT * FROM shougai_certifications
WHERE id IN (
  'e958446d-7930-481e-ae31-b68cd083a543', -- 谷口陽亮
  '150aec50-d3c2-4ee7-895a-874c430885f0', -- 小倉朋美
  'dfbe624e-8026-4f9a-9949-e4a8efb162dc'  -- 伊藤大希
);

UPDATE shougai_certifications SET jogen_kanri_office_number = '1210102263' WHERE id = 'e958446d-7930-481e-ae31-b68cd083a543'; -- 谷口陽亮 → Ｈａｎａヘルパーステーション高品
UPDATE shougai_certifications SET jogen_kanri_office_number = '1210600043' WHERE id = '150aec50-d3c2-4ee7-895a-874c430885f0'; -- 小倉朋美 → ムツミヘルパーステーション
UPDATE shougai_certifications SET jogen_kanri_office_number = '1210103394' WHERE id = 'dfbe624e-8026-4f9a-9949-e4a8efb162dc'; -- 伊藤大希 → Ｈａｎａヘルパーステーションさつきが丘

COMMIT;
