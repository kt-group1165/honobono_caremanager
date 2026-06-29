import { ClipboardList } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { UserSidebar } from "@/components/users/user-sidebar";
import {
  HoumonCarePlansContent,
  type KaigoUser,
} from "./houmon-care-plans-content";
import type { HoumonCarePlanSummary } from "@/lib/houmon-care-plan/types";

export default async function HoumonCarePlansPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>;
}) {
  const { user: userId } = await searchParams;

  let initialUser: KaigoUser | null = null;
  let initialPlans: HoumonCarePlanSummary[] = [];

  if (userId) {
    const supabase = await createClient();
    const [userRes, plansRes] = await Promise.all([
      supabase
        .from("clients")
        .select("id, name, name_kana:furigana")
        .eq("id", userId)
        .maybeSingle(),
      supabase
        .from("kaigo_houmon_care_plans")
        .select("id, plan_date, valid_from, valid_until, author_name, status, created_at, updated_at")
        .eq("user_id", userId)
        .order("plan_date", { ascending: false })
        .order("created_at", { ascending: false }),
    ]);
    if (userRes.error) {
      console.error("houmon-care-plans: user fetch failed:", userRes.error.message);
    }
    if (plansRes.error) {
      console.error("houmon-care-plans: plans fetch failed:", plansRes.error.message);
    }
    initialUser = (userRes.data ?? null) as KaigoUser | null;
    initialPlans = (plansRes.data ?? []) as HoumonCarePlanSummary[];
  }

  return (
    <div className="flex h-full -m-6">
      <UserSidebar />
      {userId ? (
        <HoumonCarePlansContent
          key={userId}
          userId={userId}
          initialUser={initialUser}
          initialPlans={initialPlans}
        />
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="rounded-lg border bg-white py-16 text-center shadow-sm">
            <ClipboardList size={40} className="mx-auto mb-3 text-gray-300" />
            <p className="text-sm text-gray-500">利用者を選択してください</p>
            <p className="mt-1 text-xs text-gray-400">訪問介護モード専用機能です</p>
          </div>
        </div>
      )}
    </div>
  );
}
