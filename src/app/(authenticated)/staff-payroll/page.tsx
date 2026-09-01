import { createClient } from "@/lib/supabase/server";
import { loadPartTimePayroll, type LoadPartTimeResult } from "@/lib/kaigo-payroll/load-part-time";
import { StaffPayrollContent } from "./staff-payroll-content";

/**
 * /staff-payroll — パート職員 給与計算 (時給×実働)
 * 事業所×月で、確定実績 (kaigo_visit_schedule status='completed') からパート職員の
 * サービス類型別 時給×実働時間 を集計する。
 */
export default async function StaffPayrollPage({
  searchParams,
}: {
  searchParams: Promise<{ office?: string }>;
}) {
  const { office: officeId } = await searchParams;
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  let initialData: LoadPartTimeResult | null = null;
  if (officeId) {
    const supabase = await createClient();
    try {
      initialData = await loadPartTimePayroll(supabase, { officeId, year, month });
    } catch {
      initialData = null;
    }
  }

  return (
    <StaffPayrollContent
      initialOfficeId={officeId ?? null}
      initialYear={year}
      initialMonth={month}
      initialData={initialData}
    />
  );
}
