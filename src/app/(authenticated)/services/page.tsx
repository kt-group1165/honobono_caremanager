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
  // Phase 9 close: members.office_id DROP 済 → member_offices junction 経由で絞り込み
  const staffQuery = officeId
    ? supabase
        .from("members")
        .select("id, name, member_offices!inner(office_id)")
        .eq("status", "active")
        .is("deleted_at", null)
        .eq("member_offices.office_id", officeId)
        .order("furigana", { nullsFirst: false })
    : null;

  // PostgREST default 1000 行制限対策で clients は page-loop。
  // 必要なのは id / name / service_category の 3 列のみ (旧: select("*") で
  // 全カラム × 全利用者を取得していて遅かった)。service_category 列が未適用の
  // 環境では 42703 になるので、その時だけ id/name に落として続行する。
  const PAGE = 1000;
  const usersAll: KaigoUser[] = [];
  {
    let cols = "id, name, service_category";
    let from = 0;
    while (true) {
      const res = await supabase
        .from("clients")
        .select(cols)
        .eq("is_facility", false)
        .is("deleted_at", null)
        .order("name")
        .range(from, from + PAGE - 1);
      if (res.error?.code === "42703" && cols !== "id, name") {
        cols = "id, name"; // service_category 未適用 → 基本列で再取得 (from 据置)
        continue;
      }
      const data = res.data;
      if (!data || data.length === 0) break;
      usersAll.push(...(data as unknown as KaigoUser[]));
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }

  const [recordsRes, staffRes] = await Promise.all([
    supabase
      .from("kaigo_service_records")
      .select("*, clients(name), members(name)")
      .order("service_date", { ascending: false })
      .order("start_time", { ascending: false })
      .limit(200),
    staffQuery ?? Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ]);

  return (
    <ServicesContent
      initialRecords={(recordsRes.data ?? []) as ServiceRecord[]}
      initialUsers={usersAll}
      initialStaff={(staffRes.data ?? []) as KaigoStaff[]}
    />
  );
}
