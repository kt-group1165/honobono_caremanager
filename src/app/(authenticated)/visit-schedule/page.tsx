import { format, startOfMonth, endOfMonth } from "date-fns";
import { createClient } from "@/lib/supabase/server";
import { VisitScheduleContent, type ScheduleEntry } from "./visit-schedule-content";

export default async function VisitSchedulePage() {
  const supabase = await createClient();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

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
    .order("start_time");

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
  const initialEntries: ScheduleEntry[] = ((data ?? []) as unknown as Row[]).map((r) => ({
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
