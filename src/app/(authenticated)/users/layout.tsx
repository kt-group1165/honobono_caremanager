import { UsersLayoutSidebar } from "./users-layout-sidebar";

/**
 * /users セグメントの共有レイアウト。
 *
 * 目的: 利用者サイドバーを [id] の外 = この親レイアウトで描画して永続化する。
 * Next.js の layout は下位セグメント ([id]) の param が変わっても再評価されない
 * ため、/users/[id] を切り替えてもサイドバーは再マウントされず、
 * 「タップのたびに全画面がスケルトン化して白くなる」現象を解消する。
 *
 * (server component。UsersLayoutSidebar は client。UserSidebar(client) を
 *  そのまま置ける形にするための薄いラッパ経由で描画する)
 *
 * -m-6 で (authenticated)/layout.tsx の main の p-6 を打ち消し、サイドバーを
 * 端まで寄せる。右ペイン側で p-6 を再付与する ([id]/page や index が padding 付きに)。
 */
export default function UsersLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full -m-6">
      <UsersLayoutSidebar />
      <div className="flex-1 overflow-y-auto p-6">{children}</div>
    </div>
  );
}
