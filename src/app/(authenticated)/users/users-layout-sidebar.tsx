"use client";

import { usePathname, useRouter } from "next/navigation";
import { UserSidebar } from "@/components/users/user-sidebar";

/**
 * /users セグメント全体で永続化する利用者サイドバー。
 *
 * users/layout.tsx (親レイアウト = [id] の外) で描画されるため、
 * /users/[id] 間のナビゲーションで再マウントされない。これにより
 * 利用者をタップするたびに起きていた「サイドバーごと白フラッシュ」を解消する。
 *
 * 選択中の利用者 id は pathname (/users/<id>/...) から導出し、
 * サイドバーのクリックは router.push で /users/<id> へ遷移する
 * (元の user-detail-layout-shell と同じ挙動)。
 */
export function UsersLayoutSidebar() {
  const pathname = usePathname();
  const router = useRouter();

  // /users/<id> または /users/<id>/<subtab> から id を抽出。
  // /users (index) では id 無し (=null) → 未選択。
  const match = pathname?.match(/^\/users\/([^/]+)/);
  const selectedUserId = match ? decodeURIComponent(match[1]) : null;

  const handleSelectUser = (newId: string) => {
    if (newId === selectedUserId) return;
    // 現在のサブタブ (/family 等) を保持して id だけ差し替える
    const suffix =
      selectedUserId && pathname
        ? pathname.slice(`/users/${selectedUserId}`.length)
        : "";
    router.push(`/users/${newId}${suffix}`);
  };

  return (
    <UserSidebar
      selectedUserId={selectedUserId}
      onSelectUser={handleSelectUser}
      showNewUserButton
    />
  );
}
