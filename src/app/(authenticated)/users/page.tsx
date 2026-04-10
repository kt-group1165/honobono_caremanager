"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Users, Plus, Loader2 } from "lucide-react";

/**
 * /users は最初のアクティブ利用者の詳細ページにリダイレクトする。
 * 利用者一覧（縦長）は /users/[id]/layout.tsx の UserSidebar で常時表示される。
 */
export default function UsersIndexPage() {
  const router = useRouter();
  const supabase = createClient();
  const [status, setStatus] = useState<"loading" | "empty" | "redirecting">(
    "loading"
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("kaigo_users")
        .select("id")
        .eq("status", "active")
        .order("name_kana", { ascending: true })
        .limit(1);
      if (cancelled) return;
      const first = data?.[0];
      if (first?.id) {
        setStatus("redirecting");
        router.replace(`/users/${first.id}`);
      } else {
        setStatus("empty");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router, supabase]);

  if (status === "empty") {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-gray-500">
        <Users size={48} className="mb-4 text-gray-300" />
        <p className="text-base font-medium mb-1">登録されている利用者がいません</p>
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

  return (
    <div className="flex items-center justify-center py-24 text-sm text-gray-400">
      <Loader2 size={16} className="animate-spin mr-2" />
      読み込み中...
    </div>
  );
}
