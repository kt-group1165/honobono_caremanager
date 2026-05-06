import { createClient } from "@/lib/supabase/server";
import { ProvidersContent, type ServiceProvider } from "./providers-content";

export default async function ProvidersPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("kaigo_service_providers")
    .select("*")
    .order("provider_name_kana");
  const initialProviders: ServiceProvider[] = (data ?? []) as ServiceProvider[];
  return <ProvidersContent initialProviders={initialProviders} />;
}
