import { format, startOfMonth, endOfMonth } from "date-fns";
import { createClient } from "@/lib/supabase/server";
import { VisitScheduleContent, type ScheduleEntry } from "./visit-schedule-content";

export default async function VisitSchedulePage() {
  const supabase = await createClient();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // PostgREST default 1000 行制限対策で page-loop で全件取得
  type Row = {
    id: string;
    user_id: string;
    visit_date: string;
    start_time: string | null;
    end_time: string | null;
    service_type: string;
    clients: { name: string } | null;
    members: { name: string } | null;
  };
  const PAGE = 1000;
  const rowsAll: Row[] = [];
  {
    let from = 0;
    while (true) {
      const { data } = await supabase
        .from("kaigo_visit_records")
        .select(`
          id,
          user_id,
          visit_date,
          start_time,
          end_time,
          service_type,
          clients(name),
          members(name)
        `)
        .gte("visit_date", format(startOfMonth(monthStart), "yyyy-MM-dd"))
        .lte("visit_date", format(endOfMonth(monthStart), "yyyy-MM-dd"))
        .order("visit_date")
        .order("start_time")
        .range(from, from + PAGE - 1);
      if (!data || data.length === 0) break;
      rowsAll.push(...(data as unknown as Row[]));
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }

  const initialEntries: ScheduleEntry[] = rowsAll.map((r) => ({
    id: r.id,
    user_id: r.user_id,
    user_name: r.clients?.name ?? "不明",
    visit_date: r.visit_date,
    start_time: r.start_time,
    end_time: r.end_time,
    service_type: r.service_type,
    staff_name: r.members?.name ?? null,
  }));

  return <VisitScheduleContent initialEntries={initialEntries} initialMonthIso={monthStart.toISOString()} />;
}
