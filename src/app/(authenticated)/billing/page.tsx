import { createClient } from "@/lib/supabase/server";
import { BillingContent, getCurrentMonth, type BillingRecord } from "./billing-content";

export default async function BillingPage() {
  const supabase = await createClient();
  const month = getCurrentMonth();
  const { data } = await supabase
    .from("kaigo_billing_records")
    .select("*, clients(name)")
    .eq("billing_month", month)
    .order("billing_month", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(500);
  const initialRecords: BillingRecord[] = (data ?? []) as BillingRecord[];
  return <BillingContent initialRecords={initialRecords} initialMonth={month} />;
}
