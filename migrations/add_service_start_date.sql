-- 介護給付費明細書 (8124/7131 種別01) 項21「開始年月日」用の列。
--   当該月に**その事業所のサービス提供を開始した利用者**にだけ設定する。
--
--   ⚠ 初回訪問日ではない (契約日)。実証: 33名中 初回訪問日と一致したのは4名だけで、
--     残りは訪問日より前だった (花見川 尾崎脩二 伝送 20260615 / 初回訪問 20260626)。
--     実績からは導けないので ほのぼのの「介護請求(明細付)_一覧.CSV」の
--     「サービス開始年月日」列から取り込む (migrations/import_meisai_service_start_date.mjs)。
--
--   client_office_assignments.start_date は一括取込の既定値 (2026-06-01) が
--   全員に入っており提供開始日として使えないため、認定レコード側に持たせる。
BEGIN;

ALTER TABLE client_insurance_records
  ADD COLUMN IF NOT EXISTS service_start_date date;

COMMENT ON COLUMN client_insurance_records.service_start_date IS
  '当該事業所のサービス提供開始年月日 (国保連 明細書 基本情報 項21)。月途中開始の利用者のみ';

COMMIT;
