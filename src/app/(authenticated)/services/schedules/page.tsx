import { format, startOfWeek, endOfWeek } from "date-fns";
import { createClient } from "@/lib/supabase/server";
import { SchedulesContent, type KaigoUser, type ServiceRecord } from "./schedules-content";

export default async function SchedulesPage() {
  const supabase = await createClient();
  const now = new Date();
  const weekStart = startOfWeek(now, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(now, { weekStartsOn: 1 });

  const [usersRes, recordsRes] = await Promise.all([
    supabase
      .from("clients")
      .select("id, name")
      .eq("is_facility", false)
      .is("deleted_at", null)
      .order("name"),
    supabase
      .from("kaigo_service_records")
      .select("*, clients(name), members(name)")
      .gte("service_date", format(weekStart, "yyyy-MM-dd"))
      .lte("service_date", format(weekEnd, "yyyy-MM-dd"))
      .order("start_time"),
  ]);

  return (
    <SchedulesContent
      initialUsers={(usersRes.data ?? []) as KaigoUser[]}
      initialRecords={(recordsRes.data ?? []) as ServiceRecord[]}
      initialWeekIso={now.toISOString()}
    />
  );
}
