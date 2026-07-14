import { createClient } from "@/lib/supabase/server";
import { isMissingPartnerSchemaError } from "../partner-companies";
import { ProvidersContent, type ServiceProvider } from "./providers-content";

// partner_companies 適用済なら法人名を embed で取得。未適用 DB では旧 select に
// フォールバックする (graceful degradation)
const SELECT_WITH_PARTNER = "*, partner_companies(name)";

export default async function ProvidersPage() {
  const supabase = await createClient();
  let rows: ServiceProvider[] = [];
  const res = await supabase
    .from("kaigo_service_providers")
    .select(SELECT_WITH_PARTNER)
    .order("provider_name_kana");
  if (res.error) {
    if (isMissingPartnerSchemaError(res.error.code)) {
      const fallback = await supabase
        .from("kaigo_service_providers")
        .select("*")
        .order("provider_name_kana");
      if (fallback.error) {
        console.error("kaigo_service_providers fetch failed:", fallback.error.message);
      }
      rows = (fallback.data ?? []) as ServiceProvider[];
    } else {
      console.error("kaigo_service_providers fetch failed:", res.error.message);
    }
  } else {
    rows = (res.data ?? []) as unknown as ServiceProvider[];
  }
  return <ProvidersContent initialProviders={rows} />;
}
