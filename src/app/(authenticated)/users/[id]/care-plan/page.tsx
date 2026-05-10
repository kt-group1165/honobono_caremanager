import { createClient } from "@/lib/supabase/server";
import type { CarePlan } from "@/types/database";
import { CarePlanContent } from "./care-plan-content";

/**
 * /users/[id]/care-plan
 * Server Component: userId に紐付く kaigo_care_plans を取得し
 * CarePlanContent (client) に initial props で渡す。
 */
export default async function CarePlanPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: userId } = await params;
  const supabase = await createClient();

  const { data } = await supabase
    .from("kaigo_care_plans")
    .select("*")
    .eq("user_id", userId)
    .order("start_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  const initialPlans: CarePlan[] = (data ?? []) as CarePlan[];

  return <CarePlanContent userId={userId} initialPlans={initialPlans} />;
}
