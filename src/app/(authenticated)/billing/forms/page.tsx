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
import { resolveKohiForMonth } from "@/lib/kohi";
import { resolveCertForMonth, type CertForMonth } from "@/lib/cert-for-month";

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

  // 1000 行制限対策の page-loop + order 付き
  const initialAllClaims: ClaimRow[] = [];
  {
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("kaigo_care_support_claims")
        .select("*")
        .eq("billing_month", billingMonth)
        .neq("status", "draft")
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) {
        console.error("レセプトの取得に失敗:", error.message);
        break;
      }
      if (!data || data.length === 0) break;
      initialAllClaims.push(...(data as ClaimRow[]));
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }

  const [ky, km] = billingMonth.split("-").map(Number);

  // 公費 (生活保護等) 情報 — 対象月の全 claims 利用者 + 選択中利用者
  const kohiUserIds = Array.from(
    new Set([
      ...initialAllClaims.map((c) => c.user_id),
      ...(userId ? [userId] : []),
    ]),
  );
  const initialKohiEntries: [string, KohiInfo][] = [];
  let certForMonth = new Map<string, CertForMonth>();
  {
    // 被保険者番号 (公費単独 = H 番号 判定用) + 認定情報は「対象月に有効な 1 件」で解決
    try {
      certForMonth = await resolveCertForMonth(supabase, kohiUserIds, ky, km);
    } catch (e) {
      console.error("認定情報の取得に失敗:", e instanceof Error ? e.message : String(e));
    }
    // 公費 (client_kohi_records) — 対象月に有効な 1 件を解決 (未作成時は旧列にフォールバック)
    try {
      const kohiRes = await resolveKohiForMonth(supabase, kohiUserIds, ky, km);
      for (const clientId of kohiUserIds) {
        const insured = certForMonth.get(clientId)?.insured_number ?? null;
        initialKohiEntries.push([
          clientId,
          toKohiInfo(insured, kohiRes.byClient.get(clientId) ?? null),
        ]);
      }
    } catch (e) {
      console.error("公費情報の取得に失敗:", e instanceof Error ? e.message : String(e));
    }
  }

  let initialUserInfo: UserInfo | null = null;
  let initialCertInfo: CertInfo | null = null;
  let initialClaims: ClaimRow[] = [];

  if (userId) {
    const [userRes, claimRes] = await Promise.all([
      supabase
        .from("clients")
        .select("id, name, furigana, gender, birth_date")
        .eq("id", userId)
        .maybeSingle(),
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
    // 認定は「対象月に有効な 1 件」(resolveCertForMonth) — 旧: 最新 1 件
    const cert = certForMonth.get(userId);
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
