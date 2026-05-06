import { createClient } from "@/lib/supabase/server";
import type { MedicalHistory } from "@/types/database";
import { HistoryContent } from "./history-content";

export default async function HistoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: userId } = await params;
  const supabase = await createClient();

  const { data } = await supabase
    .from("kaigo_medical_history")
    .select("*")
    .eq("user_id", userId)
    .order("onset_date", { ascending: false });

  const initialRecords: MedicalHistory[] = (data ?? []) as MedicalHistory[];

  return <HistoryContent userId={userId} initialRecords={initialRecords} />;
}
