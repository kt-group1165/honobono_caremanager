import { createClient } from "@/lib/supabase/server";
import { BillingCreateContent, type KaigoUser } from "./create-content";

export default async function BillingCreatePage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("clients")
    .select("id, name, furigana")
    .eq("status", "active")
    .eq("is_facility", false)
    .is("deleted_at", null)
    .order("furigana", { nullsFirst: false });
  const initialUsers: KaigoUser[] = (data ?? []) as KaigoUser[];
  return <BillingCreateContent initialUsers={initialUsers} />;
}
