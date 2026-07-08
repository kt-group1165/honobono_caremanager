"use client";

/**
 * サービス提供表の client shell。
 *
 * 利用者切替を client-side 化して高速化:
 *   旧: サイドバーで利用者クリック → ?user= 変更 → Server Component 全再実行
 *       (SSR + データ再取得 + full RSC payload) → 数秒待ち
 *   新: client state 切替 + history.replaceState で URL のみ更新
 *       (Next の再 render を起こさない) → ProvisionTicketsContent が
 *       client fetch でデータ取得 → Supabase 直 1 往復のみ
 */

import { useState } from "react";
import { UserSidebar } from "@/components/users/user-sidebar";
import {
  ProvisionTicketsContent,
  type FormulaCode,
  type GridState,
  type KaigoStaff,
  type KaigoUser,
  type OfficeInfo,
  type ServiceRow,
} from "./provision-tickets-content";

interface Props {
  initialUserId: string | null;
  initialUser: KaigoUser | null;
  initialStaff: KaigoStaff[];
  initialServiceUnits: Record<string, number>;
  initialOffice: OfficeInfo | null;
  initialServiceRows: ServiceRow[];
  initialGrid: GridState;
  initialFormulaCodes: FormulaCode[];
  /** SSR preload が成功したか。false = クライアント側で自力再フェッチさせる (自己回復) */
  initialPreloadOk?: boolean;
}

export function ProvisionTicketsShell({
  initialUserId,
  initialUser,
  initialStaff,
  initialServiceUnits,
  initialOffice,
  initialServiceRows,
  initialGrid,
  initialFormulaCodes,
  initialPreloadOk = true,
}: Props) {
  const [userId, setUserId] = useState<string | null>(initialUserId);

  const handleSelectUser = (id: string) => {
    setUserId(id);
    // URL は履歴だけ書き換え (Next の server 再実行を起こさない)
    const url = new URL(window.location.href);
    url.searchParams.set("user", id);
    window.history.replaceState(null, "", url.toString());
  };

  const isInitialUser = userId === initialUserId;

  return (
    <div className="flex h-full -m-6">
      <UserSidebar selectedUserId={userId} onSelectUser={handleSelectUser} />
      {userId ? (
        <ProvisionTicketsContent
          key={userId}
          userId={userId}
          // 初期表示の利用者だけ server の initial data を使い、
          // client 切替後は空 + serverPreloaded=false で content 側が自力 fetch
          initialUser={isInitialUser ? initialUser : null}
          initialStaff={initialStaff}
          initialServiceUnits={isInitialUser ? initialServiceUnits : {}}
          initialOffice={initialOffice}
          initialServiceRows={isInitialUser ? initialServiceRows : []}
          initialGrid={isInitialUser ? initialGrid : {}}
          initialFormulaCodes={initialFormulaCodes}
          // SSR エラー時 (initialPreloadOk=false) はクライアント再フェッチに切替
          serverPreloaded={isInitialUser && initialPreloadOk}
        />
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
            左の利用者一覧から利用者を選択してください
          </div>
        </div>
      )}
    </div>
  );
}
