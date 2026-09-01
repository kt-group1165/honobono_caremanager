import { Droplets } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { UserSidebar } from "@/components/users/user-sidebar";
import { BathProvisionContent, loadBathProvisionData, type LoadBathProvisionDataResult } from "./bath-provision-content";

const currentMonthStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export default async function BathProvisionPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string; office?: string }>;
}) {
  const { user: userId, office: officeId } = await searchParams;
  let userName: string | null = null;
  const month = currentMonthStr();
  let initialData: LoadBathProvisionDataResult | null = null;
  let loadedOfficeId: string | null = null;
  if (userId) {
    const supabase = await createClient();
    const { data } = await supabase.from("clients").select("name").eq("id", userId).maybeSingle();
    userName = (data as { name?: string } | null)?.name ?? null;

    if (officeId) {
      const [y, m] = month.split("-").map(Number);
      try {
        initialData = await loadBathProvisionData(supabase, userId, officeId, y, m);
        loadedOfficeId = officeId;
      } catch (e) {
        console.error("bath-provision: 提供表の取得に失敗:", e instanceof Error ? e.message : e);
      }
    }
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      <UserSidebar />
      {userId ? (
        <BathProvisionContent
          key={userId}
          userId={userId}
          userName={userName}
          initialOfficeId={loadedOfficeId}
          initialMonth={month}
          initialData={initialData}
        />
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
