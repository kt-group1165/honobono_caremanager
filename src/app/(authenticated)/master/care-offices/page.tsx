import { createClient } from "@/lib/supabase/server";
import { CareOfficesContent, type CareOffice } from "./care-offices-content";

export default async function CareOfficesPage() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("care_offices")
    .select("id, tenant_id, name, office_number, created_at")
    .order("name");
  if (error) {
    console.error("care_offices fetch failed:", error.message);
  }
  const initialOffices: CareOffice[] = (data ?? []) as CareOffice[];
  return <CareOfficesContent initialOffices={initialOffices} />;
}
