import { createClient } from "@/lib/supabase/server";
import { BillingCreateContent, type KaigoUser } from "./create-content";

export default async function BillingCreatePage() {
  const supabase = await createClient();
  // PostgREST default 1000 行制限対策で page-loop で全件取得
  const PAGE = 1000;
  const initialUsers: KaigoUser[] = [];
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from("clients")
      .select("id, name, furigana")
      .eq("status", "active")
      .eq("is_facility", false)
      .is("deleted_at", null)
      .order("furigana", { nullsFirst: false })
      .range(from, from + PAGE - 1);
    if (!data || data.length === 0) break;
    initialUsers.push(...(data as KaigoUser[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return <BillingCreateContent initialUsers={initialUsers} />;
}
