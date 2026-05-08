import { createClient } from "@/lib/supabase/server";
import { ServicesContent, type ServiceRecord, type KaigoUser, type KaigoStaff } from "./services-content";

export default async function ServicesPage({
  searchParams,
}: {
  searchParams: Promise<{ office?: string }>;
}) {
  const { office: officeId } = await searchParams;
  const supabase = await createClient();

  // 自事業所 (URL ?office=) のスタッフだけに絞り込む。officeId 未指定時は
  // BusinessTypeContext が初期化中なので空配列を返し、Client 側で再フェッチさせる想定。
  const staffQuery = officeId
    ? supabase
        .from("members")
        .select("id, name")
        .eq("status", "active")
        .eq("office_id", officeId)
        .order("furigana", { nullsFirst: false })
    : null;

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
    staffQuery ?? Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ]);

  return (
    <ServicesContent
      initialRecords={(recordsRes.data ?? []) as ServiceRecord[]}
      initialUsers={(usersRes.data ?? []) as KaigoUser[]}
      initialStaff={(staffRes.data ?? []) as KaigoStaff[]}
    />
  );
}
