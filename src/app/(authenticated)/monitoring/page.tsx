import { format } from "date-fns";
import { ClipboardList } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { UserSidebar } from "@/components/users/user-sidebar";
import {
  MonitoringContent,
  type CarePlanSummary,
  type KaigoUser,
  type MonitoringSheet,
} from "./monitoring-content";

export default async function MonitoringPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>;
}) {
  const { user: userId } = await searchParams;

  let initialUser: KaigoUser | null = null;
  let initialCarePlans: CarePlanSummary[] = [];
  let initialSheets: MonitoringSheet[] = [];

  if (userId) {
    const supabase = await createClient();

    const [userRes, planRes] = await Promise.all([
      supabase
        .from("clients")
        .select("id, name, name_kana")
        .eq("id", userId)
        .maybeSingle(),
      supabase
        .from("kaigo_care_plans")
        .select("id, plan_number, plan_type, start_date, end_date, status, short_term_goals")
        .eq("user_id", userId)
        .order("start_date", { ascending: false }),
    ]);
    initialUser = (userRes.data ?? null) as KaigoUser | null;
    let plans = (planRes.data ?? []) as CarePlanSummary[];

    // 自動移行: kaigo_care_plans が空でも帳票画面の計画書から復元
    if (plans.length === 0) {
      const { data: existingDocs } = await supabase
        .from("kaigo_report_documents")
        .select("id, certification_id, content, updated_at")
        .eq("user_id", userId)
        .eq("report_type", "care-plan-1")
        .order("updated_at", { ascending: false })
        .limit(1);

      if (existingDocs && existingDocs.length > 0) {
        const { data: certArr } = await supabase
          .from("client_insurance_records")
          .select("start_date:certification_start_date, end_date:certification_end_date")
          .eq("client_id", userId)
          .order("certification_start_date", { ascending: false, nullsFirst: false })
          .limit(1);
        const cert = certArr?.[0];
        const today = format(new Date(), "yyyy-MM-dd");
        const startDate = cert?.start_date ?? today;
        let endDate = cert?.end_date ?? "";
        if (!endDate) {
          const d = new Date(startDate);
          d.setFullYear(d.getFullYear() + 1);
          d.setDate(d.getDate() - 1);
          endDate = format(d, "yyyy-MM-dd");
        }

        const { data: newPlan, error: insErr } = await supabase
          .from("kaigo_care_plans")
          .insert({
            user_id: userId,
            plan_number: "",
            plan_type: "居宅サービス計画",
            start_date: startDate,
            end_date: endDate,
            long_term_goals: "",
            short_term_goals: "",
            status: "active",
          })
          .select("id, plan_number, plan_type, start_date, end_date, status, short_term_goals")
          .single();
        if (!insErr && newPlan) {
          plans = [newPlan as CarePlanSummary];
          const docId = (existingDocs[0] as { id: string }).id;
          await supabase
            .from("kaigo_report_documents")
            .update({ care_plan_id: (newPlan as { id: string }).id })
            .eq("id", docId);
        }
      }
    }

    initialCarePlans = plans;

    const initialPlanId = plans.find((p) => p.status === "active")?.id ?? plans[0]?.id ?? null;
    let q = supabase
      .from("kaigo_monitoring_sheets")
      .select("id, user_id, monitoring_date, assessor_name, status, care_plan_id, created_at")
      .eq("user_id", userId)
      .order("monitoring_date", { ascending: false });
    if (initialPlanId) q = q.eq("care_plan_id", initialPlanId);
    const { data } = await q;
    initialSheets = (data ?? []) as MonitoringSheet[];
  }

  return (
    <div className="flex h-full -m-6">
      <UserSidebar />
      {userId ? (
        <MonitoringContent
          key={userId}
          userId={userId}
          initialUser={initialUser}
          initialCarePlans={initialCarePlans}
          initialSheets={initialSheets}
        />
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <ClipboardList size={48} className="mb-4 text-gray-300" />
            <p className="text-gray-500 text-sm">利用者を選択してください</p>
          </div>
        </div>
      )}
    </div>
  );
}
