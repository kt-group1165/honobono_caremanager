import { createClient } from "@/lib/supabase/server";
import { BillingHistoryContent, type BillingRecord } from "./history-content";

export default async function BillingHistoryPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("kaigo_billing_records")
    .select("id, user_id, billing_month, service_type, total_units, total_amount, insurance_amount, copay_amount, status")
    .order("billing_month", { ascending: false })
    .limit(1000);
  const initialRecords: BillingRecord[] = (data ?? []) as BillingRecord[];
  return <BillingHistoryContent initialRecords={initialRecords} />;
}
