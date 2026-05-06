import { MessagesSquare } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { UserSidebar } from "@/components/users/user-sidebar";
import {
  MeetingMinutesContent,
  type CarePlanSummary,
  type KaigoUserLite,
  type MeetingDoc,
} from "./meeting-minutes-content";

const REPORT_TYPE = "meeting-minutes";

export default async function MeetingMinutesPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>;
}) {
  const { user: userId } = await searchParams;

  let initialUser: KaigoUserLite | null = null;
  let initialCarePlans: CarePlanSummary[] = [];
  let initialDocs: MeetingDoc[] = [];

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
        .select("id, plan_number, plan_type, start_date, end_date, status")
        .eq("user_id", userId)
        .order("start_date", { ascending: false }),
    ]);
    initialUser = (userRes.data ?? null) as KaigoUserLite | null;
    initialCarePlans = (planRes.data ?? []) as CarePlanSummary[];

    const initialPlanId = initialCarePlans.find((p) => p.status === "active")?.id
      ?? initialCarePlans[0]?.id
      ?? null;
    let q = supabase
      .from("kaigo_report_documents")
      .select("*")
      .eq("user_id", userId)
      .eq("report_type", REPORT_TYPE)
      .order("updated_at", { ascending: false });
    if (initialPlanId) q = q.eq("care_plan_id", initialPlanId);
    const { data } = await q;
    initialDocs = (data ?? []) as MeetingDoc[];
  }

  return (
    <div className="flex h-full -m-6">
      <UserSidebar />
      {userId ? (
        <MeetingMinutesContent
          key={userId}
          userId={userId}
          initialUser={initialUser}
          initialCarePlans={initialCarePlans}
          initialDocs={initialDocs}
        />
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="flex flex-col items-center justify-center py-20 text-gray-400">
            <MessagesSquare size={48} className="mb-4 text-gray-300" />
            <p className="text-sm">利用者を選択してください</p>
          </div>
        </div>
      )}
    </div>
  );
}
