import { FileText } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { UserSidebar } from "@/components/users/user-sidebar";
import {
  SupportRecordsContent,
  type CarePlanSummary,
  type KaigoUser,
  type SupportRecord,
} from "./support-records-content";

export default async function SupportRecordsPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>;
}) {
  const { user: userId } = await searchParams;

  let initialUser: KaigoUser | null = null;
  let initialCarePlans: CarePlanSummary[] = [];
  let initialRecords: SupportRecord[] = [];

  if (userId) {
    const supabase = await createClient();
    const [userRes, planRes] = await Promise.all([
      supabase
        .from("clients")
        .select("id, name, name_kana:furigana")
        .eq("id", userId)
        .maybeSingle(),
      supabase
        .from("kaigo_care_plans")
        .select("id, plan_number, plan_type, start_date, end_date, status")
        .eq("user_id", userId)
        .order("start_date", { ascending: false }),
    ]);
    initialUser = (userRes.data ?? null) as KaigoUser | null;
    initialCarePlans = (planRes.data ?? []) as CarePlanSummary[];

    const initialPlanId = initialCarePlans.find((p) => p.status === "active")?.id
      ?? initialCarePlans[0]?.id
      ?? null;
    let q = supabase
      .from("kaigo_support_records")
      .select("*")
      .eq("user_id", userId);
    if (initialPlanId) q = q.eq("care_plan_id", initialPlanId);
    const { data } = await q
      .order("record_date", { ascending: false })
      .order("record_time", { ascending: false });
    initialRecords = (data ?? []) as SupportRecord[];
  }

  return (
    <div className="flex h-full -m-6">
      <UserSidebar />
      {userId ? (
        <SupportRecordsContent
          key={userId}
          userId={userId}
          initialUser={initialUser}
          initialCarePlans={initialCarePlans}
          initialRecords={initialRecords}
        />
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="rounded-lg border bg-white py-16 text-center shadow-sm">
            <FileText size={40} className="mx-auto mb-3 text-gray-300" />
            <p className="text-sm text-gray-500">利用者を選択してください</p>
          </div>
        </div>
      )}
    </div>
  );
}
