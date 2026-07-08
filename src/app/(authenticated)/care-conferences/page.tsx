import { MessagesSquare } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { UserSidebar } from "@/components/users/user-sidebar";
import {
  CareConferencesContent,
  type CareConference,
  type UserInfo,
} from "./care-conferences-content";

// ケアカンファレンス記録 (訪問介護の個別援助会議記録)
// 保存先: kaigo_care_conferences (migrations/kaigo_care_conferences.sql)
export default async function CareConferencesPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>;
}) {
  const { user: userId } = await searchParams;

  let initialUser: UserInfo | null = null;
  let initialRecords: CareConference[] = [];
  let tableMissing = false;

  if (userId) {
    const supabase = await createClient();
    const [userRes, recordsRes] = await Promise.all([
      supabase
        .from("clients")
        .select("id, name, furigana")
        .eq("id", userId)
        .maybeSingle(),
      supabase
        .from("kaigo_care_conferences")
        .select("*")
        .eq("client_id", userId)
        .order("held_on", { ascending: false }),
    ]);
    initialUser = (userRes.data ?? null) as UserInfo | null;
    if (recordsRes.error) {
      // テーブル未作成 (migration 未適用) は amber バナー表示で続行
      if (
        recordsRes.error.code === "42P01" ||
        recordsRes.error.code === "PGRST205"
      ) {
        tableMissing = true;
      } else {
        console.error(
          "kaigo_care_conferences fetch failed:",
          recordsRes.error.message,
        );
      }
    } else {
      initialRecords = (recordsRes.data ?? []) as CareConference[];
    }
  }

  return (
    <div className="flex h-full -m-6">
      <UserSidebar />
      {userId ? (
        <CareConferencesContent
          key={userId}
          userId={userId}
          initialUser={initialUser}
          initialRecords={initialRecords}
          tableMissing={tableMissing}
        />
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="rounded-lg border bg-white py-16 text-center text-sm text-gray-500">
            <MessagesSquare size={40} className="mx-auto mb-3 text-gray-300" />
            左の利用者一覧から利用者を選択してください
          </div>
        </div>
      )}
    </div>
  );
}
