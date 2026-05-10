import { createClient } from "@/lib/supabase/server";
import { ServiceCodesContent, type ServiceCode } from "./service-codes-content";

export default async function ServiceCodesPage() {
  const supabase = await createClient();
  // PostgREST default 1000 行制限を避けるため page-loop で全件取得
  const PAGE = 1000;
  const all: ServiceCode[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("kaigo_service_codes")
      .select("*")
      .order("service_category", { ascending: true })
      .order("service_code", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) break;
    const rows = (data ?? []) as ServiceCode[];
    all.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return <ServiceCodesContent initialRecords={all} />;
}
