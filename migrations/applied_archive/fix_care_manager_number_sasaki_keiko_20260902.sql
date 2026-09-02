-- 【要確認・保留】care_manager_number 「佐々木 恵子」ぶんの番号backfill (25件)
--
--   fix_care_manager_number_batch_20260830.sql の ② で氏名のみ保存した25件について、
--   番号候補を提示する。実行前に必ずH/userの確認を得ること。
--
--   根拠: 「佐々木 恵子」の実データ(care_manager_number が既に入っている
--   既存プランのうち、CAREPLAN1.CSVの最新行の作成者が「佐々木 恵子」のもの)は
--   29件あり、うち28件が 12030438、1件だけ 12110966。
--     - 12110966 の1件(武石静子)は、29件中で唯一 CSV作成日が2026/08/27と最新
--       (=直近の担当変更の可能性がある単発の例外で、他の28件を代表する値ではないと判断)。
--     - 事業所名+ケアプラン策定機関コードは29件全て同一
--       (㈱ケイ・ティ・サービス ケアプランHana / 1270201922)なので、
--       「別の同姓同名の人」ではなく同一の策定機関に所属する1人の可能性が高い。
--   今回の対象25件は全員CSV作成日が2026/08/29 (直近の1件=12110966 の武石静子より後)
--   なので、28/29の多数派 12030438 を採用する案を提示する。
--
--   ⚠ ただし100%の確証ではない。事故が起きた場合に金額へ波及する項目
--   (国保連伝送の居宅介護支援費明細書 8124 / 給付管理票 8222 に使う番号)
--   なので、user/Hが「この根拠で十分」と判断してから実行すること。
--
-- 前提: fix_care_manager_number_batch_20260830.sql が適用済みであること
--       (backup済み、care_manager_name が入っている状態)
BEGIN;

UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = 'a842d81f-cab0-4a57-9ce2-d07a07bafa51'; -- 土屋美枝子
UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = '355edd3d-72a2-4b11-83c0-ee469cc500e3'; -- 並木 多美江
UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = 'f4d775b0-467d-416a-828c-58c128b4d214'; -- 一家 外男
UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = '2137efc7-cd2d-4c05-9ce3-48dc22118c7c'; -- 上村 亮子
UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = '1fa3c9b1-70ba-49b8-bf4e-9157819a9502'; -- 金子 生
UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = '20b33927-9163-452d-ba3c-ed0019f78288'; -- 嶋 徹
UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = '27aec9ee-206b-4e92-8631-3a32a5dca8f5'; -- 田中 均
UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = '3b5ec2f9-ecc7-4532-a49c-c9174fc4dda6'; -- 小川　 正三
UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = 'f183e469-7b1e-4f77-8628-4811fec4e34b'; -- 相内 孝敏
UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = '2638bad8-52bd-46ee-a35f-8faedb8ade1d'; -- 芹澤 寛
UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = 'b55d6f22-df1f-402a-af1c-0e385540c65f'; -- 平川 玲子
UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = 'c9ff6ff9-0d27-495b-902e-97718433cba5'; -- 稲葉 隆昭
UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = '8175828f-aeaf-49c3-aa40-7f6add91383f'; -- 上原 福善
UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = '6ebdc923-0205-4891-bbf9-a695da2d5431'; -- 大島 保
UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = '574a3224-5045-419f-9cda-d0ef43aabab6'; -- 岡村 行造
UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = '850c2fda-9a05-411a-ad43-dd3095432dfc'; -- 田岡 千惠子
UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = '3f01bad3-38d9-4d77-91ed-535247ce5715'; -- 丹羽 正弘
UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = '60c927c6-10d4-48ac-8362-00e29aba8696'; -- 濱崎 千恵子
UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = '310bde8e-3370-4efa-8f30-b7b67da951e2'; -- 鈴木 保廣
UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = 'df15a5ff-6fb9-4384-9e2f-d4867bba39e0'; -- 濱崎 雅一
UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = '1aa19231-c5fe-49cf-8758-4962521203a0'; -- 寺島 良典
UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = '4ef3d93d-8eb7-4d01-b9c5-cbb5b3b1726d'; -- 渡邉 義明
UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = '8ebd1cab-10a3-42cc-bbdd-592a401d4cb5'; -- 錦織 まさ
UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = 'e37d9349-b9f1-4d3d-9e83-d99e6056d91a'; -- 岸 敏子
UPDATE kaigo_care_plans SET care_manager_number = '12030438' WHERE id = 'dcd1da65-7f1d-4660-9759-161ebd2e6482'; -- 小塚 明

COMMIT;
