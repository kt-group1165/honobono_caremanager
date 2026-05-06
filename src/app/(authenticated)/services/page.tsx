import { createClient } from "@/lib/supabase/server";
import { ServicesContent, type ServiceRecord, type KaigoUser, type KaigoStaff } from "./services-content";

export default async function ServicesPage() {
  const supabase = await createClient();

  const [recordsRes, usersRes, staffRes] = await Promise.all([
    supabase
      .from("kaigo_service_records")
      .select("*, clients(name), members(name)")
      .order("service_date", { ascending: false })
      .order("start_time", { ascending: false })
      .limit(200),
    supabase
      .from("clients")
      .select("id, name")
      .eq("is_facility", false)
      .is("deleted_at", null)
      .order("name"),
    supabase
      .from("members")
      .select("id, name")
      .eq("status", "active")
      .order("furigana", { nullsFirst: false }),
  ]);

  return (
    <ServicesContent
      initialRecords={(recordsRes.data ?? []) as ServiceRecord[]}
      initialUsers={(usersRes.data ?? []) as KaigoUser[]}
      initialStaff={(staffRes.data ?? []) as KaigoStaff[]}
    />
  );
}
