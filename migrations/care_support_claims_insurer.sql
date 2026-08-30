-- ============================================================================
-- kaigo_care_support_claims を **転居月の 2 レセプト**に対応させる
--
-- ── なぜ要るか ──────────────────────────────────────────────────────────
--   月の途中で転居して保険者が変わると、**1 人が 2 枚のレセプト**になる。
--   新旧それぞれの保険者に別々に請求するため。
--
--     加藤綾子 2026-06
--       141143|0004595039  19,092円 (転居前)
--       122390|0202242821  22,227円 (転居後・初回加算あり)
--       合計 41,319 円
--
--   ところがこの表は **(user_id, billing_month) で一意**なので 1 枚しか持てず、
--   後から取り込んだほうで **黙って上書き**される。取りこぼしに気づけない。
--
--   伝送を作る側 (src/lib/cert-for-month.ts / kokuho-densou/build-kyotaku.ts) は
--   保険者変更のセグメント分割に既に対応済み。**レセプト表だけが追いついていない**。
--
-- ── 何をするか ──────────────────────────────────────────────────────────
--   ① insurer_number / insured_number を持たせる (どの保険者への請求かを記録)
--   ② 一意制約を (user_id, billing_month) → (user_id, billing_month, insurer_number)
--      に張り替える
--
--   ⚠ 既存行は insurer_number が NULL。**NULL は「保険者を特定していない従来行」**。
--     Postgres の UNIQUE は NULL 同士を重複と見なさないので、そのままだと
--     同じ利用者・同じ月の NULL 行が何枚でも入ってしまう。
--     → **NULL を空文字 '' に正規化**して 1 枚に保つ。
--
--   ⚠ 既存の参照 (57 箇所 / 15 ファイル) は insurer_number を見ないので
--     従来どおり動く。転居していない人は 1 枚のままで挙動が変わらない。
--
-- 実行: Supabase SQL Editor に貼って Run
-- ============================================================================
BEGIN;

ALTER TABLE kaigo_care_support_claims
  ADD COLUMN IF NOT EXISTS insurer_number text NOT NULL DEFAULT '';

ALTER TABLE kaigo_care_support_claims
  ADD COLUMN IF NOT EXISTS insured_number text;

COMMENT ON COLUMN kaigo_care_support_claims.insurer_number IS
  'どの保険者への請求か。転居月は 1 人が保険者ごとに 2 枚になる。'''' = 従来行 (保険者未特定)';
COMMENT ON COLUMN kaigo_care_support_claims.insured_number IS
  '被保険者番号。⚠ 保険者の中でしか一意でないので insurer_number と対で扱う';

-- 一意制約の張り替え: (user_id, billing_month) → (user_id, billing_month, insurer_number)
ALTER TABLE kaigo_care_support_claims
  DROP CONSTRAINT IF EXISTS kaigo_care_support_claims_user_id_billing_month_key;

CREATE UNIQUE INDEX IF NOT EXISTS kaigo_care_support_claims_user_month_insurer_key
  ON kaigo_care_support_claims (user_id, billing_month, insurer_number);

CREATE INDEX IF NOT EXISTS idx_care_support_claims_insurer
  ON kaigo_care_support_claims (billing_month, insurer_number);

COMMIT;
