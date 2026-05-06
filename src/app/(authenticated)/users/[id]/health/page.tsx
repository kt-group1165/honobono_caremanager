import { createClient } from "@/lib/supabase/server";
import type { HealthRecord } from "@/types/database";
import { HealthContent } from "./health-content";

export default async function HealthPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: userId } = await params;
  const supabase = await createClient();

  const { data } = await supabase
    .from("kaigo_health_records")
    .select("*")
    .eq("user_id", userId)
    .order("record_date", { ascending: false });

  const initialRecords: HealthRecord[] = (data ?? []) as HealthRecord[];

  return <HealthContent userId={userId} initialRecords={initialRecords} />;
}
