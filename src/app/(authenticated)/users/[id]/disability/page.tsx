import { createClient } from "@/lib/supabase/server";
import { DisabilityContent, type DisabilityCert } from "./disability-content";

export default async function DisabilityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: userId } = await params;
  const supabase = await createClient();

  const { data } = await supabase
    .from("client_disability_certifications")
    .select("*")
    .eq("user_id", userId)
    .order("period_start", { ascending: false, nullsFirst: false });

  const initialRecords: DisabilityCert[] = (data ?? []) as DisabilityCert[];

  return <DisabilityContent userId={userId} initialRecords={initialRecords} />;
}
