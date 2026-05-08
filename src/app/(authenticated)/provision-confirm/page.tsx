import { createClient } from "@/lib/supabase/server";
import { ProvisionConfirmContent, type ProvisionUser } from "./provision-confirm-content";

export default async function ProvisionConfirmPage() {
  const supabase = await createClient();

  // PostgREST default 1000 行制限対策で page-loop で全件取得
  type UserRow = { id: string; name: string; name_kana: string | null; care_level: string | null };
  const PAGE = 1000;
  const userData: UserRow[] = [];
  {
    let from = 0;
    while (true) {
      const { data } = await supabase
        .from("clients")
        .select("id, name, name_kana:furigana, care_level, status")
        .eq("status", "active")
        .eq("is_facility", false)
        .order("furigana")
        .range(from, from + PAGE - 1);
      if (!data || data.length === 0) break;
      userData.push(...(data as UserRow[]));
      if (data.length < PAGE) break;
      from += PAGE;
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
