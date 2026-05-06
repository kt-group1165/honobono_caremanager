import { format, startOfMonth, endOfMonth } from "date-fns";
import { createClient } from "@/lib/supabase/server";
import { VisitBillingContent, type RawRecord } from "./visit-billing-content";

export default async function VisitBillingPage() {
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
      clients(name, name_kana:furigana)
    `)
    .gte("visit_date", format(startOfMonth(monthStart), "yyyy-MM-dd"))
    .lte("visit_date", format(endOfMonth(monthStart), "yyyy-MM-dd"))
    .order("visit_date");

  return (
    <VisitBillingContent
      initialRecords={(data ?? []) as RawRecord[]}
      initialMonthIso={monthStart.toISOString()}
    />
  );
}
