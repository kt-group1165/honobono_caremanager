import { createClient } from "@/lib/supabase/server";
import { isMissingPartnerSchemaError } from "../partner-companies";
import { OfficesMasterTabs, type OfficesTab } from "./offices-master-tabs";
import type { OfficeSettings } from "../office/office-content";
import type { CareOffice } from "../care-offices/care-offices-content";
import type { ServiceProvider } from "../providers/providers-content";

// 事業所マスタ 統合ページ (自社グループ / 他社:居宅・ケアマネ / 他社:サービス提供)。
// 旧 /master/office · /master/care-offices · /master/providers はここへ ?tab= 付きで
// リダイレクトされる。各タブの初期データを 3 本並行 fetch して client シェルへ渡す。

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
  // partner_companies 適用済なら法人名を embed、未適用なら旧 select にフォールバック
  const res = await supabase.from("care_offices").select(CARE_WITH_PARTNER).order("name");
  if (!res.error) return (res.data ?? []) as unknown as CareOffice[];
  if (isMissingPartnerSchemaError(res.error.code)) {
    const fb = await supabase.from("care_offices").select(CARE_PLAIN).order("name");
    if (fb.error) console.error("care_offices fetch failed:", fb.error.message);
    return (fb.data ?? []) as CareOffice[];
  }
  console.error("care_offices fetch failed:", res.error.message);
  return [];
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
