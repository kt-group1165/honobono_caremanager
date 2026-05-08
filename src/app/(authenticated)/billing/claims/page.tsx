import { createClient } from "@/lib/supabase/server";
import {
  ClaimsContent,
  getCurrentMonth,
  type CertMapEntry,
  type ClaimRow,
  type ClaimsOfficeInfo,
} from "./claims-content";

export default async function ClaimsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const sp = await searchParams;
  const billingMonth = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : getCurrentMonth();

  const supabase = await createClient();

  const [officeRes, claimsRes] = await Promise.all([
    supabase
      .from("offices")
      .select("tokutei_kassan_type, medical_cooperation_kassan, area_category, unit_price, provider_number:business_number")
      .eq("app_type", "kaigo-app")
      .limit(1)
      .maybeSingle(),
    supabase
      .from("kaigo_care_support_claims")
      .select("*, clients(name, name_kana:furigana, gender, phone, mobile_phone:mobile)")
      .eq("billing_month", billingMonth)
      .order("created_at", { ascending: true }),
  ]);

  const initialOfficeInfo = (officeRes.data ?? null) as ClaimsOfficeInfo;
  const initialClaims = ((claimsRes.data ?? []) as ClaimRow[]);

  const userIds = [...new Set(initialClaims.map((r) => r.user_id))];
  let initialCertEntries: [string, CertMapEntry][] = [];
  if (userIds.length > 0) {
    // PostgREST default 1000 行制限対策で page-loop で全件取得
    type CertRow = { client_id: string; care_level: string; insurer_number: string | null; insured_number: string | null; certification_start_date: string | null; certification_end_date: string | null };
    const PAGE = 1000;
    const certs: CertRow[] = [];
    let fromC = 0;
    while (true) {
      const { data } = await supabase
        .from("client_insurance_records")
        .select("client_id, care_level, insurer_number, insured_number, certification_start_date, certification_end_date")
        .in("client_id", userIds)
        .order("certification_date", { ascending: false })
        .range(fromC, fromC + PAGE - 1);
      if (!data || data.length === 0) break;
      certs.push(...(data as CertRow[]));
      if (data.length < PAGE) break;
      fromC += PAGE;
    }
    const map = new Map<string, CertMapEntry>();
    for (const cert of certs) {
      if (!map.has(cert.client_id)) {
        map.set(cert.client_id, {
          care_level: cert.care_level,
          insurer_number: cert.insurer_number ?? null,
          insured_number: cert.insured_number ?? null,
          start_date: cert.certification_start_date ?? null,
          end_date: cert.certification_end_date ?? null,
        });
      }
    }
    initialCertEntries = [...map.entries()];
  }

  return (
    <ClaimsContent
      initialBillingMonth={billingMonth}
      initialClaims={initialClaims}
      initialCertEntries={initialCertEntries}
      initialOfficeInfo={initialOfficeInfo}
    />
  );
}
