import { createClient } from "@/lib/supabase/server";
import {
  BenefitsContent,
  getCurrentMonth,
  type BenefitManagementRow,
  type CareCertification,
  type UserWithCert,
} from "./benefits-content";

export default async function BenefitsPage() {
  const supabase = await createClient();
  const month = getCurrentMonth();

  // PostgREST default 1000 行制限対策で page-loop で全件取得
  type UsersRow = {
    id: string;
    name: string;
    client_insurance_records?: CareCertification | CareCertification[] | null;
  };
  const PAGE = 1000;
  const usersAll: UsersRow[] = [];
  {
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("clients")
        .select(
          "id, name, client_insurance_records(id, client_id, insured_number, care_level, service_limit_amount, insurer_number)"
        )
        .eq("status", "active")
        .eq("is_facility", false)
        .is("deleted_at", null)
        .order("name")
        .range(from, from + PAGE - 1);
      if (error) break;
      if (!data || data.length === 0) break;
      usersAll.push(...(data as UsersRow[]));
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }
  const rowsRes = await supabase
    .from("kaigo_benefit_management")
    .select("*")
    .eq("billing_month", month)
    .order("user_id")
    .order("service_type");

  const initialUsers: UserWithCert[] = usersAll.map((u) => {
    const cert = Array.isArray(u.client_insurance_records)
      ? u.client_insurance_records[0] ?? null
      : u.client_insurance_records ?? null;
    return { id: u.id, name: u.name, certification: cert };
  });

  return (
    <BenefitsContent
      initialMonth={month}
      initialUsers={initialUsers}
      initialRows={(rowsRes.data ?? []) as BenefitManagementRow[]}
    />
  );
}
