import { format, startOfWeek, endOfWeek } from "date-fns";
import { createClient } from "@/lib/supabase/server";
import { SchedulesContent, type KaigoUser, type ServiceRecord } from "./schedules-content";

export default async function SchedulesPage() {
  const supabase = await createClient();
  const now = new Date();
  const weekStart = startOfWeek(now, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(now, { weekStartsOn: 1 });

  // PostgREST default 1000 行制限対策で clients は page-loop
  const PAGE = 1000;
  const usersAll: KaigoUser[] = [];
  {
    let from = 0;
    while (true) {
      const { data } = await supabase
        .from("clients")
        .select("id, name")
        .eq("is_facility", false)
        .is("deleted_at", null)
        .order("name")
        .range(from, from + PAGE - 1);
      if (!data || data.length === 0) break;
      usersAll.push(...(data as KaigoUser[]));
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }

  const recordsRes = await supabase
    .from("kaigo_service_records")
    .select("*, clients(name), members(name)")
    .gte("service_date", format(weekStart, "yyyy-MM-dd"))
    .lte("service_date", format(weekEnd, "yyyy-MM-dd"))
    .order("start_time");

  return (
    <SchedulesContent
      initialUsers={usersAll}
      initialRecords={(recordsRes.data ?? []) as ServiceRecord[]}
      initialWeekIso={now.toISOString()}
    />
  );
}
