import { createClient } from "@/lib/supabase/server";
import { UserSidebar } from "@/components/users/user-sidebar";
import {
  HoumonCarePlansContent,
  type KaigoUser,
} from "./houmon-care-plans-content";
import { HoumonCarePlanOverview } from "./houmon-care-plan-overview";
import {
  HOUMON_CARE_PLAN_SUMMARY_COLUMNS,
  type HoumonCarePlanSummary,
} from "@/lib/houmon-care-plan/types";
import { isSchemaV1Error } from "@/lib/houmon-care-plan/queries";

export default async function HoumonCarePlansPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>;
}) {
  const { user: userId } = await searchParams;

  let initialUser: KaigoUser | null = null;
  let initialPlans: HoumonCarePlanSummary[] = [];
  let schemaOutdated = false;

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
        .select(HOUMON_CARE_PLAN_SUMMARY_COLUMNS)
        .eq("user_id", userId)
        .order("plan_date", { ascending: false })
        .order("created_at", { ascending: false }),
    ]);
    if (userRes.error) {
      console.error("houmon-care-plans: user fetch failed:", userRes.error.message);
    }
    if (plansRes.error) {
      // v2 migration 未適用 (列が無い) の場合は UI に案内を出す。それ以外は log のみ。
      if (isSchemaV1Error(plansRes.error)) {
        schemaOutdated = true;
        console.error(
          "houmon-care-plans: v2 migration 未適用 (migrations/applied_archive/houmon_care_plans_v2.sql):",
          plansRes.error.message,
        );
      } else {
        console.error("houmon-care-plans: plans fetch failed:", plansRes.error.message);
      }
    }
    initialUser = (userRes.data ?? null) as KaigoUser | null;
    initialPlans = (plansRes.data ?? []) as unknown as HoumonCarePlanSummary[];
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
          initialSchemaOutdated={schemaOutdated}
        />
      ) : (
        // 利用者 未選択時は自事業所の作成状況一覧 (未作成 / 期限切れ の洗い出し)
        <HoumonCarePlanOverview />
      )}
    </div>
  );
}
