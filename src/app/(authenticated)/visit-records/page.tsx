import { User } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { UserSidebar } from "@/components/users/user-sidebar";
import { VisitRecordsContent } from "./visit-records-content";

interface KaigoStaff {
  id: string;
  name: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = any;

export default async function VisitRecordsPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>;
}) {
  const { user: userId } = await searchParams;
  const supabase = await createClient();

  const { data: staffData } = await supabase
    .from("members")
    .select("id, name")
    .eq("status", "active")
    .order("name");
  const initialStaff = (staffData ?? []) as KaigoStaff[];

  let initialRecords: AnyRecord[] = [];
  let initialUserName: string | null = null;
  if (userId) {
    const [recordsRes, clientRes] = await Promise.all([
      supabase
        .from("kaigo_visit_records")
        .select("*, members(name)")
        .eq("user_id", userId)
        .order("visit_date", { ascending: false })
        .order("start_time", { ascending: false }),
      supabase.from("clients").select("name").eq("id", userId).maybeSingle(),
    ]);
    initialRecords = (recordsRes.data ?? []).map((r: AnyRecord) => ({
      ...r,
      staff_name: r.members?.name ?? null,
    }));
    initialUserName = (clientRes.data as { name?: string } | null)?.name ?? null;
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      <UserSidebar />
      {userId ? (
        <VisitRecordsContent
          key={userId}
          userId={userId}
          userName={initialUserName}
          initialRecords={initialRecords as never}
          initialStaff={initialStaff}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
          <div className="text-center">
            <User size={32} className="mx-auto mb-2 text-gray-300" />
            <p>左の利用者一覧から対象者を選択してください</p>
          </div>
        </div>
      )}
    </div>
  );
}
