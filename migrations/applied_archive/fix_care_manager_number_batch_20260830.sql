-- care_manager_number 反映漏れ是正 (2026-08-30 PDF取込バッチ、全40件)
--   import_care_plans_from_honobono_csv.mjs 由来のケアプラン(全40件・24拠点)が
--   care_manager_number を一切設定しない経路だったため丸ごとNULLだった件の是正。
--   (発端: 高品 前嶋明・菊地滉の反映漏れ報告 → 横展開調査で同バッチ全体の欠落と判明)
--
--   ⚠ 実行前に add_care_manager_name.sql を先に適用しておくこと (care_manager_name 列が必要)。
--
--   突合方法: CAREPLAN1.CSV の「作成者」氏名 × 既にcare_manager_numberが入っている
--   2,760件の実データ(業務で使われている居宅サービス計CSV由来の正式な値)を突き合わせ、
--   ある作成者名が常に同じ番号に対応する(矛盾ゼロ)場合のみ①番号まで採用。
--   矛盾がある名前(同姓同名の可能性)は②氏名のみ保存し番号は空のままにした。
--
-- ① 番号まで解決 (15件、実データで矛盾ゼロ)
-- ② 氏名のみ (番号は実データで一意に定まらず要確認、25件。全員「佐々木 恵子」)
--    → 佐々木恵子は実データ29件中28件が12030438、1件だけ12110966(かつCSV日付が
--      唯一この29件中で最新=2026/08/27、単発の例外の可能性が高い)。
--      評価・適用は fix_care_manager_number_sasaki_keiko_20260902.sql (別ファイル、
--      user/H確認後に実行) を参照。
--
-- 詳細はK→H報告 2026-09-02 参照
BEGIN;

-- backup
CREATE TABLE _backup_kaigo_care_plans_cm_20260902 AS
SELECT * FROM kaigo_care_plans
WHERE created_at >= '2026-08-30' AND created_at < '2026-08-31' AND care_manager_number IS NULL;

-- ① 番号まで解決 (15件)
UPDATE kaigo_care_plans SET care_manager_number = '12040466', care_manager_name = '三枝 文子' WHERE id = '22bb53dd-9560-4d30-af58-20f12ec6cae2'; -- 鈴木 和子
UPDATE kaigo_care_plans SET care_manager_number = '09160062', care_manager_name = '佐藤 芳美' WHERE id = '63cb3282-fe90-4b31-8131-46ec4d5eb018'; -- 菊地 滉
UPDATE kaigo_care_plans SET care_manager_number = '12050887', care_manager_name = '中込 トモ子' WHERE id = 'db1cf62a-7034-4315-8bde-fcea22631ed9'; -- 北原 武夫
UPDATE kaigo_care_plans SET care_manager_number = '12070836', care_manager_name = '内海 典子' WHERE id = 'ef218aca-f933-4a15-9a0e-ab959a84e6bd'; -- 平野 みさ子
UPDATE kaigo_care_plans SET care_manager_number = '12020096', care_manager_name = '鍋川 早苗' WHERE id = '7a48d986-611c-4acd-bcac-522f325e1c98'; -- 芹澤 正子
UPDATE kaigo_care_plans SET care_manager_number = '12190060', care_manager_name = '髙橋 和子' WHERE id = 'd29041a0-8bf2-47af-9ef2-f83033add0a3'; -- 大塚 昇
UPDATE kaigo_care_plans SET care_manager_number = '12100095', care_manager_name = '山科 博美' WHERE id = 'ccde82f4-d0ab-4ea2-8824-23e62f349da0'; -- 池田 芳勝
UPDATE kaigo_care_plans SET care_manager_number = '12120018', care_manager_name = '足立 和江' WHERE id = '1c0c6862-49a8-4071-8383-b4e060915c38'; -- 櫻田 數枝
UPDATE kaigo_care_plans SET care_manager_number = '12120018', care_manager_name = '足立 和江' WHERE id = 'b2bb01fe-7f29-40bc-826c-c7f6d4912a6b'; -- 堀江 佳子
UPDATE kaigo_care_plans SET care_manager_number = '12120018', care_manager_name = '足立 和江' WHERE id = 'ec0b30bd-3ba1-40cb-bb42-5a048c4f27ba'; -- 宮川 将三
UPDATE kaigo_care_plans SET care_manager_number = '12120018', care_manager_name = '足立 和江' WHERE id = 'a1ca6573-c9bc-4524-bb60-f4678471a60b'; -- 宮川 哲子
UPDATE kaigo_care_plans SET care_manager_number = '12110106', care_manager_name = '平野 節子' WHERE id = 'dbe99731-c71e-447a-a69d-a613926305f2'; -- 小賀坂 豊
UPDATE kaigo_care_plans SET care_manager_number = '12181325', care_manager_name = '間宮 奈保' WHERE id = 'ef3cd23a-8078-4d66-8547-28c071822ab1'; -- 千綿 和子
UPDATE kaigo_care_plans SET care_manager_number = '12120204', care_manager_name = '小林 康子' WHERE id = 'e6400c08-0f85-4784-af28-9ae734c44380'; -- 前嶋 明
UPDATE kaigo_care_plans SET care_manager_number = '12040064', care_manager_name = '服部 美栄' WHERE id = '1178523b-49d5-4c0e-bd46-2fc8634d5749'; -- 小池 美乃里

-- ② 氏名のみ (番号は実データで一意に定まらず要確認、25件。全員「佐々木 恵子」)
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = 'a842d81f-cab0-4a57-9ce2-d07a07bafa51'; -- 土屋美枝子
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = '355edd3d-72a2-4b11-83c0-ee469cc500e3'; -- 並木 多美江
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = 'f4d775b0-467d-416a-828c-58c128b4d214'; -- 一家 外男
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = '2137efc7-cd2d-4c05-9ce3-48dc22118c7c'; -- 上村 亮子
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = '1fa3c9b1-70ba-49b8-bf4e-9157819a9502'; -- 金子 生
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = '20b33927-9163-452d-ba3c-ed0019f78288'; -- 嶋 徹
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = '27aec9ee-206b-4e92-8631-3a32a5dca8f5'; -- 田中 均
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = '3b5ec2f9-ecc7-4532-a49c-c9174fc4dda6'; -- 小川　 正三
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = 'f183e469-7b1e-4f77-8628-4811fec4e34b'; -- 相内 孝敏
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = '2638bad8-52bd-46ee-a35f-8faedb8ade1d'; -- 芹澤 寛
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = 'b55d6f22-df1f-402a-af1c-0e385540c65f'; -- 平川 玲子
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = 'c9ff6ff9-0d27-495b-902e-97718433cba5'; -- 稲葉 隆昭
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = '8175828f-aeaf-49c3-aa40-7f6add91383f'; -- 上原 福善
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = '6ebdc923-0205-4891-bbf9-a695da2d5431'; -- 大島 保
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = '574a3224-5045-419f-9cda-d0ef43aabab6'; -- 岡村 行造
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = '850c2fda-9a05-411a-ad43-dd3095432dfc'; -- 田岡 千惠子
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = '3f01bad3-38d9-4d77-91ed-535247ce5715'; -- 丹羽 正弘
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = '60c927c6-10d4-48ac-8362-00e29aba8696'; -- 濱崎 千恵子
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = '310bde8e-3370-4efa-8f30-b7b67da951e2'; -- 鈴木 保廣
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = 'df15a5ff-6fb9-4384-9e2f-d4867bba39e0'; -- 濱崎 雅一
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = '1aa19231-c5fe-49cf-8758-4962521203a0'; -- 寺島 良典
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = '4ef3d93d-8eb7-4d01-b9c5-cbb5b3b1726d'; -- 渡邉 義明
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = '8ebd1cab-10a3-42cc-bbdd-592a401d4cb5'; -- 錦織 まさ
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = 'e37d9349-b9f1-4d3d-9e83-d99e6056d91a'; -- 岸 敏子
UPDATE kaigo_care_plans SET care_manager_name = '佐々木 恵子' WHERE id = 'dcd1da65-7f1d-4660-9759-161ebd2e6482'; -- 小塚 明

COMMIT;
