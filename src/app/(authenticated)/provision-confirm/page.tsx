import { createClient } from "@/lib/supabase/server";
import { ProvisionConfirmContent, type ProvisionUser } from "./provision-confirm-content";

export default async function ProvisionConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ office?: string }>;
}) {
  const { office: officeId } = await searchParams;
  const supabase = await createClient();

  // 自事業所 (URL ?office=) の利用者だけに絞る (shift-management/page.tsx と同 pattern):
  //   1) client_office_assignments で officeId の client_id を page-loop 取得
  //   2) その id 集合の clients を .in(500件chunk) で取得
  // officeId 未指定時 (context 初期化中) は空 → Client 側で currentOfficeId 解決後に再フェッチ。
  // 旧: 全事業所の全 active 利用者を取得していて遅く、他事業所の利用者も混ざっていた。
  type UserRow = { id: string; name: string; name_kana: string | null; care_level: string | null };
  const PAGE = 1000;
  const userData: UserRow[] = [];
  if (officeId) {
    const clientIdsAll: string[] = [];
    let fromA = 0;
    while (true) {
      const { data: assigns, error } = await supabase
        .from("client_office_assignments")
        .select("client_id")
        .eq("office_id", officeId)
        .is("end_date", null)
        .order("id").range(fromA, fromA + PAGE - 1);
      if (error) break;
      if (!assigns || assigns.length === 0) break;
      clientIdsAll.push(...(assigns as { client_id: string }[]).map((a) => a.client_id));
      if (assigns.length < PAGE) break;
      fromA += PAGE;
    }
    const uniqueIds = Array.from(new Set(clientIdsAll));
    for (let i = 0; i < uniqueIds.length; i += 500) {
      const chunk = uniqueIds.slice(i, i + 500);
      const { data } = await supabase
        .from("clients")
        .select("id, name, name_kana:furigana, care_level, status")
        .in("id", chunk)
        .eq("status", "active")
        .eq("is_facility", false)
        .is("deleted_at", null)
        .order("furigana");
      userData.push(...((data ?? []) as UserRow[]));
    }
  }

  let initialUsers: ProvisionUser[] = [];
  if (userData.length > 0) {
    const userIds = userData.map((u) => u.id);
    const { data: docData } = await supabase
      .from("kaigo_report_documents")
      .select("id, user_id, period_start, period_end, status, document_type")
      .in("user_id", userIds)
      .in("document_type", ["service-usage", "provision-sheet"])
      .order("period_start", { ascending: false });

    type Doc = { id: string; user_id: string; period_start: string | null; period_end: string | null; status: string | null };
    const docByUser: Record<string, Doc> = {};
    for (const doc of (docData ?? []) as Doc[]) {
      if (!docByUser[doc.user_id]) {
        docByUser[doc.user_id] = doc;
      }
    }

    initialUsers = userData.map((u) => {
      const doc = docByUser[u.id] ?? null;
      return {
        user_id: u.id,
        user_name: u.name,
        user_name_kana: u.name_kana,
        care_level: u.care_level,
        latest_period_start: doc?.period_start ?? null,
        latest_period_end: doc?.period_end ?? null,
        document_id: doc?.id ?? null,
        document_status: doc?.status ?? null,
      };
    });
  }

  return <ProvisionConfirmContent initialUsers={initialUsers} />;
}
