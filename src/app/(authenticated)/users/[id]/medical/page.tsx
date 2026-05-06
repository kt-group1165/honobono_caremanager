import { createClient } from "@/lib/supabase/server";
import type { MedicalInsurance } from "@/types/database";
import { MedicalContent } from "./medical-content";

export default async function MedicalPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: userId } = await params;
  const supabase = await createClient();

  const { data } = await supabase
    .from("kaigo_medical_insurance")
    .select("*")
    .eq("user_id", userId)
    .order("start_date", { ascending: false });

  const initialRecords: MedicalInsurance[] = (data ?? []) as MedicalInsurance[];

  return <MedicalContent userId={userId} initialRecords={initialRecords} />;
}
