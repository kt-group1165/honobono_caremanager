import { createClient } from "@/lib/supabase/server";
import { isMissingPartnerSchemaError } from "../partner-companies";
import { OfficesMasterTabs, type OfficesTab } from "./offices-master-tabs";
import type { OfficeSettings } from "../office/office-content";
import type { CareOffice } from "../care-offices/care-offices-content";
import type { ServiceProvider } from "../providers/providers-content";

// 事業所マスタ 統合ページ (自社グループ / 他社:居宅・ケアマネ / 他社:サービス提供)。
// 旧 /master/office · /master/care-offices · /master/providers はここへ ?tab= 付きで
// リダイレクトされる。各タブの初期データを 3 本並行 fetch して client シェルへ渡す。

// self_office_id IS NULL = 他社のみ。自社紐づけ済 (self_office_id あり) は
// 自社グループタブ側の offices に出るため、他社タブからは除外する。
const CARE_FULL =
  "id, tenant_id, name, office_number, created_at, self_office_id, partner_company_id, partner_companies(name)";
const CARE_WITH_PARTNER =
  "id, tenant_id, name, office_number, created_at, partner_company_id, partner_companies(name)";
const CARE_PLAIN = "id, tenant_id, name, office_number, created_at";
const PROVIDER_WITH_PARTNER = "*, partner_companies(name)";

async function fetchGroupOffices(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<OfficeSettings[]> {
  const { data, error } = await supabase
    .from("offices")
    .select("*")
    .eq("app_type", "kaigo-app")
    .order("name");
  if (error) console.error("offices fetch failed:", error.message);
  return (data ?? []) as OfficeSettings[];
}

async function fetchCareOffices(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<CareOffice[]> {
  // ① self_office_id + partner 両適用: 他社 (self_office_id IS NULL) のみ
  const full = await supabase
    .from("care_offices")
    .select(CARE_FULL)
    .is("self_office_id", null)
    .order("name");
  if (!full.error) return (full.data ?? []) as unknown as CareOffice[];
  if (!isMissingPartnerSchemaError(full.error.code)) {
    console.error("care_offices fetch failed:", full.error.message);
    return [];
  }
  // ② self_office_id 未適用: partner 法人名のみ (全件、フィルタなし)
  const withPartner = await supabase.from("care_offices").select(CARE_WITH_PARTNER).order("name");
  if (!withPartner.error) return (withPartner.data ?? []) as unknown as CareOffice[];
  if (!isMissingPartnerSchemaError(withPartner.error.code)) {
    console.error("care_offices fetch failed:", withPartner.error.message);
    return [];
  }
  // ③ partner も未適用: 旧 select
  const plain = await supabase.from("care_offices").select(CARE_PLAIN).order("name");
  if (plain.error) console.error("care_offices fetch failed:", plain.error.message);
  return (plain.data ?? []) as CareOffice[];
}

async function fetchProviders(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<ServiceProvider[]> {
  const res = await supabase
    .from("kaigo_service_providers")
    .select(PROVIDER_WITH_PARTNER)
    .order("provider_name_kana");
  if (!res.error) return (res.data ?? []) as unknown as ServiceProvider[];
  if (isMissingPartnerSchemaError(res.error.code)) {
    const fb = await supabase
      .from("kaigo_service_providers")
      .select("*")
      .order("provider_name_kana");
    if (fb.error) console.error("kaigo_service_providers fetch failed:", fb.error.message);
    return (fb.data ?? []) as ServiceProvider[];
  }
  console.error("kaigo_service_providers fetch failed:", res.error.message);
  return [];
}

export default async function OfficesMasterPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const sp = await searchParams;
  const initialTab: OfficesTab = (["group", "care", "provider"] as const).includes(
    sp.tab as OfficesTab,
  )
    ? (sp.tab as OfficesTab)
    : "group";

  const supabase = await createClient();
  const [groupOffices, careOffices, providers] = await Promise.all([
    fetchGroupOffices(supabase),
    fetchCareOffices(supabase),
    fetchProviders(supabase),
  ]);

  return (
    <OfficesMasterTabs
      initialTab={initialTab}
      groupOffices={groupOffices}
      careOffices={careOffices}
      providers={providers}
    />
  );
}
