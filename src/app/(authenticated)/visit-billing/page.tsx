import { format, startOfMonth, endOfMonth } from "date-fns";
import { createClient } from "@/lib/supabase/server";
import { VisitBillingContent, type RawRecord } from "./visit-billing-content";

export default async function VisitBillingPage() {
  const supabase = await createClient();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // PostgREST default 1000 行制限対策で page-loop で全件取得
  const PAGE = 1000;
  const all: RawRecord[] = [];
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
          clients(name, name_kana:furigana)
        `)
        .gte("visit_date", format(startOfMonth(monthStart), "yyyy-MM-dd"))
        .lte("visit_date", format(endOfMonth(monthStart), "yyyy-MM-dd"))
        .order("visit_date")
        .range(from, from + PAGE - 1);
      if (!data || data.length === 0) break;
      all.push(...(data as RawRecord[]));
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }

  return (
    <VisitBillingContent
      initialRecords={all}
      initialMonthIso={monthStart.toISOString()}
    />
  );
}
