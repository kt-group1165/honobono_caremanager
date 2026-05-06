import { createClient } from "@/lib/supabase/server";
import type { AdlRecord } from "@/types/database";
import { AdlContent } from "./adl-content";

/**
 * /users/[id]/adl
 * Server Component: userId に紐付く kaigo_adl_records を取得し
 * AdlContent (client) に initial props で渡す。
 */
export default async function AdlPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: userId } = await params;
  const supabase = await createClient();

  const { data } = await supabase
    .from("kaigo_adl_records")
    .select("*")
    .eq("user_id", userId)
    .order("assessment_date", { ascending: false });

  const initialRecords: AdlRecord[] = (data ?? []) as AdlRecord[];

  return <AdlContent userId={userId} initialRecords={initialRecords} />;
}
