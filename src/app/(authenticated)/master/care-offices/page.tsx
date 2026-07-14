import { createClient } from "@/lib/supabase/server";
import { isMissingPartnerSchemaError } from "../partner-companies";
import { CareOfficesContent, type CareOffice } from "./care-offices-content";

// partner_companies 適用済なら法人名を embed で取得。未適用 DB では旧 select に
// フォールバックする (graceful degradation)
const SELECT_WITH_PARTNER =
  "id, tenant_id, name, office_number, created_at, partner_company_id, partner_companies(name)";
const SELECT_PLAIN = "id, tenant_id, name, office_number, created_at";

export default async function CareOfficesPage() {
  const supabase = await createClient();
  let rows: CareOffice[] = [];
  const res = await supabase.from("care_offices").select(SELECT_WITH_PARTNER).order("name");
  if (res.error) {
    if (isMissingPartnerSchemaError(res.error.code)) {
      const fallback = await supabase.from("care_offices").select(SELECT_PLAIN).order("name");
      if (fallback.error) {
        console.error("care_offices fetch failed:", fallback.error.message);
      }
      rows = (fallback.data ?? []) as CareOffice[];
    } else {
      console.error("care_offices fetch failed:", res.error.message);
    }
  } else {
    rows = (res.data ?? []) as unknown as CareOffice[];
  }
  return <CareOfficesContent initialOffices={rows} />;
}
