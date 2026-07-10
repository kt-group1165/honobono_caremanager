-- ============================================================================
-- kaigo_visit_schedule: 追加職員 (最大10名) を jsonb 列 additional_staff に持たせる
-- ============================================================================
-- 従来は職員が固定3枠 (staff_id 主 / staff_id_2 / staff_id_3) だったが、
-- 2人体制+同行研修等で最大10名 (主1 + 追加9) を各自の個別時間つきで登録できるように
-- jsonb 列 additional_staff を追加する。
--
-- 形式: [{"staff_id":"<uuid>","start_time":"HH:MM:SS"|null,"end_time":"HH:MM:SS"|null}, ...]
--   = 主担当 (staff_id) を除く追加職員の配列 (index0=職員2, index1=職員3, index2=職員4…)。
--   start_time / end_time が null は「本体 (start_time/end_time) と同じ時間」を意味する。
--
-- 後方互換: アプリは保存時に additional_staff の先頭2件を従来列
--   staff_id_2 / staff_id_3 + staff2/3_start/end_time にもミラー書き込みする。
--   よって請求集計・2人加算・各 read 画面 (従来列を読む既存コード) は無変更で動く。
--   3人目以降は記録/給与用 (請求単位は増えない: 2人加算は最大2人)。
--
-- ※ このファイルは適用しない (ユーザーが Supabase SQL Editor で実行する)。

BEGIN;

ALTER TABLE kaigo_visit_schedule
  ADD COLUMN IF NOT EXISTS additional_staff JSONB;

COMMENT ON COLUMN kaigo_visit_schedule.additional_staff IS
  '主担当(staff_id)を除く追加職員の配列 [{staff_id,start_time,end_time}]。start/end が null は本体と同じ時間。先頭2件は staff_id_2/staff_id_3 + staff2/3_*_time にミラー';

-- 既存の staff_id_2 / staff_id_3 + 個別時間を additional_staff へ移行 (両方 NULL の行はスキップ)。
UPDATE kaigo_visit_schedule
SET additional_staff = (
  SELECT jsonb_agg(elem ORDER BY ord)
  FROM (
    SELECT 1 AS ord,
           jsonb_build_object(
             'staff_id', staff_id_2::text,
             'start_time', staff2_start_time::text,
             'end_time', staff2_end_time::text
           ) AS elem
    WHERE staff_id_2 IS NOT NULL
    UNION ALL
    SELECT 2 AS ord,
           jsonb_build_object(
             'staff_id', staff_id_3::text,
             'start_time', staff3_start_time::text,
             'end_time', staff3_end_time::text
           ) AS elem
    WHERE staff_id_3 IS NOT NULL
  ) AS elems
)
WHERE (staff_id_2 IS NOT NULL OR staff_id_3 IS NOT NULL)
  AND additional_staff IS NULL;

COMMIT;
