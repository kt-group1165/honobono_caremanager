import { createClient } from "@/lib/supabase/server";
import { BathRecordsContent, type Client, type Staff, type BathRecord } from "./bath-records-content";

const currentMonthStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export default async function BathRecordsPage({
  searchParams,
}: {
  searchParams: Promise<{ office?: string }>;
}) {
  const { office: officeId } = await searchParams;
  const supabase = await createClient();
  const month = currentMonthStr();

  let initialClients: Client[] = [];
  let initialStaff: Staff[] = [];
  let initialRecords: BathRecord[] = [];

  if (officeId) {
    const { data: assigns } = await supabase
      .from("client_office_assignments")
      .select("client_id")
      .eq("office_id", officeId);
    const ids = Array.from(new Set((assigns ?? []).map((a: { client_id: string }) => a.client_id)));

    const [clientsRes, staffRes, recordsRes] = await Promise.all([
      ids.length
        ? supabase.from("clients").select("id, name, furigana, user_number").in("id", ids).is("deleted_at", null).order("furigana")
        : Promise.resolve({ data: [] }),
      supabase.from("members").select("id, name").eq("status", "active").is("deleted_at", null).order("name"),
      supabase
        .from("kaigo_bath_visit_records")
        .select("*")
        .eq("office_id", officeId)
        .gte("visit_date", `${month}-01`)
        .lte("visit_date", `${month}-31`)
        .order("visit_date", { ascending: false }),
    ]);
    initialClients = (clientsRes.data ?? []) as Client[];
    initialStaff = (staffRes.data ?? []) as Staff[];
    initialRecords = (recordsRes.data ?? []) as BathRecord[];
  }

  return (
    <BathRecordsContent
      initialOfficeId={officeId ?? null}
      initialMonth={month}
      initialClients={initialClients}
      initialStaff={initialStaff}
      initialRecords={initialRecords}
    />
  );
}
