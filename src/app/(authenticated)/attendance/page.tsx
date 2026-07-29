import { Suspense } from "react";
import { KyotakuAttendanceContent } from "@/components/attendance/attendance-content";

/**
 * /attendance — 出勤簿 (居宅介護支援 / 訪問介護 / 訪問入浴)
 *
 * payroll-app の居宅出勤簿を移設したもの (2026-07-29、project_app_business_mapping)。
 * - 居宅介護支援: 日次 + 月次 (介護/予防件数・ケアマネ加算) + 固定残業超過警告
 * - 訪問介護・訪問入浴: 日次のみ。「対象者設定」で出勤簿を作る人だけに絞れる
 * - table は payroll-app と共有 (payroll_kyotaku_attendance_records ほか)
 */
export default function AttendancePage() {
  return (
    // useSearchParams (deep link 用) を使うため Suspense 境界が必要
    <Suspense fallback={null}>
      <KyotakuAttendanceContent />
    </Suspense>
  );
}
