import { format, startOfMonth, endOfMonth } from "date-fns";
import { createClient } from "@/lib/supabase/server";
import { VisitScheduleContent, type ScheduleEntry } from "./visit-schedule-content";

export default async function VisitSchedulePage() {
  const supabase = await createClient();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // 予定・実績の実体は kaigo_visit_schedule (シフト管理・提供表と同一データ)。
  // 旧実装は kaigo_visit_records (実施記録) を読んでおり、シフト/提供表で作った
  // 予定が表示されなかった (監査#8)。PostgREST 1000 行制限対策で page-loop。
  type Row = {
    id: string;
    user_id: string;
    visit_date: string;
    start_time: string | null;
    end_time: string | null;
    service_type: string;
    status: string;
    clients: { name: string } | null;
    members: { name: string } | null;
  };
  const PAGE = 1000;
  const rowsAll: Row[] = [];
  {
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("kaigo_visit_schedule")
        .select(`
          id,
          user_id,
          visit_date,
          start_time,
          end_time,
          service_type,
          status,
          clients(name),
          members(name)
        `)
        .gte("visit_date", format(startOfMonth(monthStart), "yyyy-MM-dd"))
        .lte("visit_date", format(endOfMonth(monthStart), "yyyy-MM-dd"))
        .neq("status", "cancelled")
        .order("visit_date")
        .order("start_time")
        .range(from, from + PAGE - 1);
      // silent failure 防止: 取得失敗は「予定なし」に見えるため必ずログに残す
      if (error) console.error("[visit-schedule] kaigo_visit_schedule fetch failed:", error.message);
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
    status: r.status,
    staff_name: r.members?.name ?? null,
  }));

  return <VisitScheduleContent initialEntries={initialEntries} initialMonthIso={monthStart.toISOString()} />;
}
