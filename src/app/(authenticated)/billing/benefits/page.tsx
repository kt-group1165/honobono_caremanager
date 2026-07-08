import { createClient } from "@/lib/supabase/server";
import { resolveCertForMonth, type CertForMonth } from "@/lib/cert-for-month";
import { BenefitsContent } from "./benefits-content";
import {
  getCurrentMonth,
  type BenefitManagementRow,
  type CareCertification,
  type UserWithCert,
} from "./benefits-shared";

export default async function BenefitsPage() {
  const supabase = await createClient();
  const month = getCurrentMonth();

  // PostgREST default 1000 行制限対策で page-loop で全件取得
  type UsersRow = { id: string; name: string };
  const PAGE = 1000;
  const usersAll: UsersRow[] = [];
  {
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("clients")
        .select("id, name")
        .eq("status", "active")
        .eq("is_facility", false)
        .is("deleted_at", null)
        .order("name")
        .order("id", { ascending: true })
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

  // 認定は「対象月に有効な 1 件」で解決 (旧: embed [0] = 任意の 1 件)
  const [cy, cm] = month.split("-").map(Number);
  let certRes = new Map<string, CertForMonth>();
  try {
    certRes = await resolveCertForMonth(
      supabase,
      usersAll.map((u) => u.id),
      cy,
      cm,
    );
  } catch (e) {
    console.error("認定情報の取得に失敗:", e instanceof Error ? e.message : String(e));
  }

  const initialUsers: UserWithCert[] = usersAll.map((u) => {
    const cert = certRes.get(u.id);
    const certification: CareCertification | null = cert
      ? {
          id: "",
          client_id: u.id,
          insured_number: cert.insured_number ?? "",
          care_level: cert.care_level ?? "",
          service_limit_amount: cert.service_limit_amount ?? 0,
          insurer_number: cert.insurer_number ?? undefined,
        }
      : null;
    return { id: u.id, name: u.name, certification };
  });

  return (
    <BenefitsContent
      initialMonth={month}
      initialUsers={initialUsers}
      initialRows={(rowsRes.data ?? []) as BenefitManagementRow[]}
    />
  );
}
