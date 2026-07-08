import { format } from "date-fns";
import { createClient } from "@/lib/supabase/server";
import { UserSidebar } from "@/components/users/user-sidebar";
import {
  BillingFormsContent,
  type CertInfo,
  type ClaimRow,
  type OfficeInfo,
  type UserInfo,
} from "./billing-forms-content";
import { toKohiInfo, type KohiInfo } from "./forms-shared";

function getCurrentMonth(): string {
  return format(new Date(), "yyyy-MM");
}

export default async function BillingFormsPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string; month?: string }>;
}) {
  const sp = await searchParams;
  const userId = sp.user;
  const billingMonth = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : getCurrentMonth();

  const supabase = await createClient();

  const { data: officeData } = await supabase
    .from("offices")
    .select("name, business_number, address, phone, area_category, unit_price, postal_code")
    .eq("app_type", "kaigo-app")
    .limit(1)
    .maybeSingle();
  const initialOffice: OfficeInfo | null = officeData
    ? {
        provider_number: officeData.business_number ?? "",
        office_name: officeData.name ?? "",
        address: officeData.address ?? "",
        phone: officeData.phone ?? "",
        area_category: officeData.area_category ?? "",
        unit_price: officeData.unit_price ?? 10,
        postal_code: officeData.postal_code ?? "",
      }
    : null;

  const { data: allClaimData } = await supabase
    .from("kaigo_care_support_claims")
    .select("*")
    .eq("billing_month", billingMonth)
    .neq("status", "draft");
  const initialAllClaims = (allClaimData ?? []) as ClaimRow[];

  // 公費 (生活保護等) 情報 — 対象月の全 claims 利用者 + 選択中利用者の最新保険記録
  const kohiUserIds = Array.from(
    new Set([
      ...initialAllClaims.map((c) => c.user_id),
      ...(userId ? [userId] : []),
    ]),
  );
  const initialKohiEntries: [string, KohiInfo][] = [];
  {
    const seen = new Set<string>();
    for (let i = 0; i < kohiUserIds.length; i += 50) {
      const chunk = kohiUserIds.slice(i, i + 50);
      const { data, error } = await supabase
        .from("client_insurance_records")
        .select("client_id, insured_number, kohi_hobetsu, kohi_futansha_number, kohi_jukyusha_number, effective_date")
        .in("client_id", chunk)
        .order("effective_date", { ascending: false });
      if (error) {
        console.error("公費情報の取得に失敗:", error.message);
        continue;
      }
      for (const r of (data ?? []) as {
        client_id: string;
        insured_number: string | null;
        kohi_hobetsu: string | null;
        kohi_futansha_number: string | null;
        kohi_jukyusha_number: string | null;
      }[]) {
        if (seen.has(r.client_id)) continue; // 最新 (effective_date DESC) の 1 件のみ
        seen.add(r.client_id);
        initialKohiEntries.push([r.client_id, toKohiInfo(r)]);
      }
    }
  }

  let initialUserInfo: UserInfo | null = null;
  let initialCertInfo: CertInfo | null = null;
  let initialClaims: ClaimRow[] = [];

  if (userId) {
    const [userRes, certRes, claimRes] = await Promise.all([
      supabase
        .from("clients")
        .select("id, name, furigana, gender, birth_date")
        .eq("id", userId)
        .maybeSingle(),
      supabase
        .from("client_insurance_records")
        .select("insurer_number, insured_number, care_level, certification_start_date, certification_end_date")
        .eq("client_id", userId)
        .order("certification_start_date", { ascending: false, nullsFirst: false })
        .limit(1),
      supabase
        .from("kaigo_care_support_claims")
        .select("*")
        .eq("user_id", userId)
        .eq("billing_month", billingMonth)
        .neq("status", "draft"),
    ]);
    const u = userRes.data;
    initialUserInfo = u ? {
      id: u.id,
      name: u.name ?? "",
      name_kana: u.furigana ?? "",
      gender: u.gender ?? "",
      birth_date: u.birth_date ?? "",
    } : null;
    const cert = certRes.data?.[0];
    initialCertInfo = cert ? {
      insurer_number: cert.insurer_number ?? "",
      insured_number: cert.insured_number ?? "",
      care_level: cert.care_level ?? "",
      start_date: cert.certification_start_date ?? "",
      end_date: cert.certification_end_date ?? "",
    } : null;
    initialClaims = (claimRes.data ?? []) as ClaimRow[];
  }

  return (
    <div className="flex h-full -m-6">
      <UserSidebar />
      {userId ? (
        <BillingFormsContent
          key={userId}
          userId={userId}
          initialMonth={billingMonth}
          initialOffice={initialOffice}
          initialUserInfo={initialUserInfo}
          initialCertInfo={initialCertInfo}
          initialClaims={initialClaims}
          initialAllClaims={initialAllClaims}
          initialKohiEntries={initialKohiEntries}
        />
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="rounded-lg border bg-white py-16 text-center text-sm text-gray-500">
            左の利用者一覧から利用者を選択してください
          </div>
        </div>
      )}
    </div>
  );
}
