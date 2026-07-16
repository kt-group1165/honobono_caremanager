import { StaffPayrollContent } from "./staff-payroll-content";

/**
 * /staff-payroll — パート職員 給与計算 (時給×実働)
 * 事業所×月で、確定実績 (kaigo_visit_schedule status='completed') からパート職員の
 * サービス類型別 時給×実働時間 を集計する。
 */
export default function StaffPayrollPage() {
  return <StaffPayrollContent />;
}
