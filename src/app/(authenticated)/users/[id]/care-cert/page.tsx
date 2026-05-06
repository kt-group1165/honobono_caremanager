import { createClient } from "@/lib/supabase/server";
import type { CareCertification } from "@/types/database";
import { CareCertContent } from "./care-cert-content";

export default async function CareCertPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: userId } = await params;
  const supabase = await createClient();

  const { data } = await supabase
    .from("client_insurance_records")
    .select("*")
    .eq("client_id", userId)
    .order("certification_start_date", { ascending: false, nullsFirst: false });

  const initialRecords: CareCertification[] = (data ?? []) as CareCertification[];

  return <CareCertContent userId={userId} initialRecords={initialRecords} />;
}
