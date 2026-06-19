"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Users, Plus, Loader2 } from "lucide-react";
import { useBusinessType } from "@/lib/business-type-context";
import { useKaigoOfficeUsers } from "@/lib/swr/use-kaigo-office-users";

/**
 * /users は「自事業所一覧の 1 番上」の利用者詳細にリダイレクトする。
 *
 * 以前は server 側で全テナントの最初の active client へ飛ばしていたが、
 * それだと「自事業所」タブの 1 番目とずれて、サイドバーと右ペインが乖離した。
 *
 * 並びは use-kaigo-office-users.ts と同一 (furigana 昇順、nullsFirst: false)。
 * 自事業所に利用者が居なければ「自事業所の利用者なし」表示にし、新規登録 CTA を出す。
 * このページは loading.tsx (skeleton) と組み合わせて初回 paint が遅れないようにしている。
 */
export default function UsersIndexPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { currentOfficeId, loading: officeLoading } = useBusinessType();
  const { users, isLoading } = useKaigoOfficeUsers(currentOfficeId);

  const first = users[0];

  useEffect(() => {
    if (officeLoading) return;
    if (isLoading) return;
    if (!first?.id) return;
    // ?office= 等の query param を保持して redirect (= 自事業所 context を失わない)
    const qs = searchParams.toString();
    router.replace(`/users/${first.id}${qs ? `?${qs}` : ""}`);
  }, [officeLoading, isLoading, first?.id, router, searchParams]);

  // currentOfficeId が解決済 & users 取得済 & 0 件 → 空状態 CTA
  const showEmpty =
    !officeLoading && !isLoading && currentOfficeId && users.length === 0;

  if (showEmpty) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-gray-500">
        <Users size={48} className="mb-4 text-gray-300" />
        <p className="text-base font-medium mb-1">自事業所に登録されている利用者がいません</p>
        <p className="text-sm text-gray-400 mb-4">
          新規利用者を登録して利用者管理を開始してください
        </p>
        <Link
          href="/users/new"
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
        >
          <Plus size={16} />
          新規利用者登録
        </Link>
      </div>
    );
  }

  // それ以外 (office / users fetch 中、または redirect 直前) は軽い loading 表示
  return (
    <div className="flex h-full items-center justify-center py-24 text-gray-400">
      <Loader2 size={20} className="mr-2 animate-spin" />
      <span className="text-sm">読込中...</span>
    </div>
  );
}
