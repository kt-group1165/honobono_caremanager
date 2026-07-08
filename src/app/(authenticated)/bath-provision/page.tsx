import { Droplets } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { UserSidebar } from "@/components/users/user-sidebar";
import { BathProvisionContent } from "./bath-provision-content";

export default async function BathProvisionPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>;
}) {
  const { user: userId } = await searchParams;
  let userName: string | null = null;
  if (userId) {
    const supabase = await createClient();
    const { data } = await supabase.from("clients").select("name").eq("id", userId).maybeSingle();
    userName = (data as { name?: string } | null)?.name ?? null;
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      <UserSidebar />
      {userId ? (
        <BathProvisionContent key={userId} userId={userId} userName={userName} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
          <div className="text-center">
            <Droplets size={32} className="mx-auto mb-2 text-gray-300" />
            <p>左の利用者一覧から対象者を選択してください</p>
          </div>
        </div>
      )}
    </div>
  );
}
