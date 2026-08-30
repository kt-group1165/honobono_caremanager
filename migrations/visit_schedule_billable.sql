-- ============================================================================
-- kaigo_visit_schedule に「請求する / しない」を持たせる
--
-- ── なぜ要るか ──────────────────────────────────────────────────────────
--   重度訪問介護のような長時間の支援では、1 本の提供の中に **請求できない時間**が
--   混ざる。代表は休憩。ヘルパーは利用者宅に居て給与も発生するが、
--   サービス提供ではないので報酬は請求できない (事業所の持ち出し)。
--
--   ほのぼのは 給与用 (NEXT 賃金集計) と 請求用 (more 実績記録票) を
--   **別々の画面に二重入力**して、請求側にだけ休憩の行を作らないという運用。
--   これだと片方だけ直したときに整合が崩れる。実際そうなっていた。
--
--     NEXT 賃金集計    09:00-12:00 + 12:00-13:00 + 13:00-17:00   8.0h  給与
--     more 実績記録票  09:00-12:00 +               13:00-17:00   7.0h  請求
--
--   → 新システムは **1 行に「請求する」フラグ**を持ち、1 入力から出し分ける。
--
-- ── 重要 ────────────────────────────────────────────────────────────────
--   ⚠ このフラグが触るのは **請求だけ**。**給与は全行に払う**。
--     給与計算 (kaigo-payroll) は billable を見ない。
--     請求集計 (shogai-seikyu / visit-seikyu) だけが billable=true で絞る。
--
--   ⚠ 行は消さない。シフト上は 09:00-17:00 が 1 本の支援として残る。
--     「請求しなかった 1 時間」ではなく、その時間が実在した記録が残る。
--
--   既存行はすべて true。今の動きは変わらない。
--
-- 実行: Supabase SQL Editor に貼って Run
-- ============================================================================
BEGIN;

ALTER TABLE kaigo_visit_schedule
  ADD COLUMN IF NOT EXISTS billable boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN kaigo_visit_schedule.billable IS
  '請求対象か。false = 給与は払うが請求はしない (休憩 等)。給与計算は本列を見ない';

-- 請求集計は billable=true かつ status='completed' で引くので複合で張る
CREATE INDEX IF NOT EXISTS idx_kaigo_visit_schedule_billable
  ON kaigo_visit_schedule (office_id, visit_date, billable)
  WHERE status = 'completed';

COMMIT;
