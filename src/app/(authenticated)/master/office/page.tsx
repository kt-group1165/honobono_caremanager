import { createClient } from "@/lib/supabase/server";
import { OfficeContent, type OfficeSettings } from "./office-content";

export default async function OfficeSettingsPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("offices")
    .select("*")
    .eq("app_type", "kaigo-app")
    .order("name");
  const initialOffices: OfficeSettings[] = (data ?? []) as OfficeSettings[];
  return <OfficeContent initialOffices={initialOffices} />;
}
