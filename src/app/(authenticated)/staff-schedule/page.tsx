import { StaffScheduleContent } from "./staff-schedule-content";

// 勤務形態一覧表 (参考様式1)
//   2026-09-01 監査是正で新設。実地指導で最初に提出を求められる帳票。
//   監査で「新しく作らないと出せない 6 つ」の最後の 1 つ。
//   新規テーブルは作らず、members / member_offices に列を 2 つ足して集計する。
//   保存先: migrations/staff_schedule_hours_v1.sql
export default function StaffSchedulePage() {
  return (
    <div className="flex h-full -m-6">
      <StaffScheduleContent />
    </div>
  );
}
