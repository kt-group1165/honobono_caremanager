import { Building2 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { UserSidebar } from "@/components/users/user-sidebar";
import {
  HospitalizationsContent,
  type Hospitalization,
  type UserInfo,
} from "./hospitalizations-content";

export default async function HospitalizationsPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>;
}) {
  const { user: userId } = await searchParams;

  let initialUser: UserInfo | null = null;
  let initialRecords: Hospitalization[] = [];

  if (userId) {
    const supabase = await createClient();
    const [userRes, recordsRes] = await Promise.all([
      supabase
        .from("clients")
        .select("id, name, furigana")
        .eq("id", userId)
        .maybeSingle(),
      supabase
        .from("client_hospitalizations")
        .select("*")
        .eq("client_id", userId)
        .order("admission_date", { ascending: false }),
    ]);
    initialUser = (userRes.data ?? null) as UserInfo | null;
    initialRecords = (recordsRes.data ?? []) as Hospitalization[];
  }

  return (
    <div className="flex h-full -m-6">
      <UserSidebar />
      {userId ? (
        <HospitalizationsContent
          key={userId}
          userId={userId}
          initialUser={initialUser}
          initialRecords={initialRecords}
        />
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="rounded-lg border bg-white py-16 text-center text-sm text-gray-500">
            <Building2 size={40} className="mx-auto mb-3 text-gray-300" />
            左の利用者一覧から利用者を選択してください
          </div>
        </div>
      )}
    </div>
  );
}
