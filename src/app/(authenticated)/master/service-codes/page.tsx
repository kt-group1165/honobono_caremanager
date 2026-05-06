import { createClient } from "@/lib/supabase/server";
import { ServiceCodesContent, type ServiceCode } from "./service-codes-content";

export default async function ServiceCodesPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("kaigo_service_codes")
    .select("*")
    .order("service_category", { ascending: true })
    .order("service_code", { ascending: true })
    .limit(1000);
  const initialRecords: ServiceCode[] = (data ?? []) as ServiceCode[];
  return <ServiceCodesContent initialRecords={initialRecords} />;
}
