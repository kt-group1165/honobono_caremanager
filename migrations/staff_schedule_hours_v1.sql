-- apps/kaigo-app/migrations/staff_schedule_hours_v1.sql
-- 2026-09-01 監査是正: 勤務形態一覧表 (参考様式1) を出すための列を追加。
--
-- 【なぜ要るか】
--   勤務形態一覧表は実地指導で**最初に提出を求められる**帳票。
--   人員基準 (訪問介護のサ責は利用者 40 人に 1 人、居宅のケアマネは 35 人に 1 人 等) を
--   常勤換算数で示すもの。2026-08-31 監査で「置き場が無い 6 つ」の最後の 1 つ。
--
-- 【なぜテーブルではなく列なのか】
--   氏名・職種・資格・雇用形態・入職日は members に、事業所との紐付けは
--   member_offices に既にある。専従/兼務も member_offices の件数から出せる。
--   足りないのは **週の所定勤務時間** と **常勤職員の週所定時間** の 2 つだけ。
--   実績時間は出勤簿にあるが、出勤簿を持つのは実測 10 名だけ (payroll_kyotaku_
--   attendance_records 401 行 / payroll_attendance_records 1,142 行) で
--   members 1,191 名を賄えない。そもそもこの様式は**予定の勤務時間**で書くものなので、
--   所定時間を持たせるのが素直。
--
-- 【常勤換算数】
--   = 従業者の週の勤務時間の合計 ÷ 常勤職員が勤務すべき週の時間数
--   常勤の週所定時間は事業所の就業規則によるので offices 側に持つ (既定 40)。
--   ⚠ 32 時間を下回る場合は 32 として扱う等の細則があるが、自治体差があるため
--     **システムでは丸めない**。画面は素の計算値を出し、判断は人がする。

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

ALTER TABLE members
  ADD COLUMN IF NOT EXISTS weekly_scheduled_hours NUMERIC(5,2);

COMMENT ON COLUMN members.weekly_scheduled_hours IS
  '週の所定勤務時間。勤務形態一覧表 (参考様式1) の常勤換算に使う。'
  ' NULL = 未設定 (一覧では「—」で出し、常勤換算の分子に入れない)。';

ALTER TABLE offices
  ADD COLUMN IF NOT EXISTS fulltime_weekly_hours NUMERIC(5,2) DEFAULT 40;

COMMENT ON COLUMN offices.fulltime_weekly_hours IS
  '常勤職員が勤務すべき週の時間数 (就業規則による。既定 40)。'
  ' 常勤換算数 = 従業者の週の勤務時間の合計 ÷ この値。';

DO $$
DECLARE v_m INT; v_o INT;
BEGIN
  SELECT COUNT(*) INTO v_m FROM information_schema.columns
   WHERE table_schema='public' AND table_name='members' AND column_name='weekly_scheduled_hours';
  SELECT COUNT(*) INTO v_o FROM information_schema.columns
   WHERE table_schema='public' AND table_name='offices' AND column_name='fulltime_weekly_hours';
  IF v_m <> 1 OR v_o <> 1 THEN
    RAISE EXCEPTION '検証失敗: members=% / offices=%', v_m, v_o;
  END IF;
  RAISE NOTICE '✓ members.weekly_scheduled_hours / offices.fulltime_weekly_hours を追加しました';
END $$;

COMMIT;

-- ロールバック:
--   ALTER TABLE members DROP COLUMN IF EXISTS weekly_scheduled_hours;
--   ALTER TABLE offices DROP COLUMN IF EXISTS fulltime_weekly_hours;
