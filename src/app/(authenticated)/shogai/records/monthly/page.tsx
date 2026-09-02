import { createClient } from "@/lib/supabase/server";
import {
  ShogaiMonthlyContent,
  loadShogaiUsers,
  loadShogaiMonthlyData,
  type ShogaiMonthlyData,
} from "./monthly-content";

// 障害福祉 実績月間管理 (ほのぼのmore の予定実績管理画面 参考)
//
// Server Component: 受給者証を持つ利用者一覧は officeId 非依存なので常に SSR で取得する。
// 明細 (計画/実績/コード名/受給者証) は officeId が要る (shogai_service_records の
// office スコープ) ため、URL に ?office= がある時だけ先読みし、無ければ null で
// client 側 fetch にフォールバックする (idou-billing 等と同じパターン)。
export default async function ShogaiMonthlyPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string; office?: string }>;
}) {
  const { user: userParam, office: officeId } = await searchParams;
  const supabase = await createClient();

  let initialUsers: { id: string; name: string }[] | undefined;
  try {
    initialUsers = await loadShogaiUsers(supabase);
  } catch {
    initialUsers = undefined; // client 側で再取得させる
  }

  // ?user= 優先、無ければ一覧の先頭 (client 側の既定と揃える)
  const initialUserId = userParam ?? initialUsers?.[0]?.id;

  const now = new Date();
  let initialData: ShogaiMonthlyData | undefined;
  if (initialUserId && officeId) {
    try {
      initialData = await loadShogaiMonthlyData(supabase, {
        userId: initialUserId,
        officeId,
        year: now.getFullYear(),
        month: now.getMonth() + 1,
      });
    } catch {
      initialData = undefined;
    }
  }

  return (
    <ShogaiMonthlyContent
      initialUsers={initialUsers}
      initialUserId={initialUserId}
      initialOfficeId={officeId ?? null}
      initialData={initialData}
    />
  );
}
