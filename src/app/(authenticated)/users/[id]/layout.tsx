"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { differenceInYears, parseISO, format } from "date-fns";
import { ChevronLeft, User } from "lucide-react";
import type { KaigoUser } from "@/types/database";

/**
 * 利用者詳細画面の共有レイアウト
 * - 上部: パンくず + 利用者ヘッダー
 * - タブメニュー: 「基本情報」「介護保険」の 2 大タブ + それぞれのサブタブ
 * - 下部: children (各サブページのコンテンツ)
 */

type SubTab = { label: string; href: string };

const BASIC_TABS: SubTab[] = [
  { label: "基本情報", href: "" },
  { label: "親族・関係者", href: "/family" },
  { label: "既往歴", href: "/history" },
  { label: "ADL", href: "/adl" },
  { label: "健康管理", href: "/health" },
];

const INSURANCE_TABS: SubTab[] = [
  { label: "介護認定", href: "/care-cert" },
  { label: "医療保険", href: "/medical" },
];

type MainTab = "basic" | "insurance";

const STATUS_LABELS: Record<string, string> = {
  active: "在籍中",
  inactive: "退所",
  deceased: "死亡",
};

export default function UserDetailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams<{ id: string }>();
  const pathname = usePathname();
  const id = params?.id;
  const supabase = createClient();

  const [user, setUser] = useState<KaigoUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from("kaigo_users")
        .select("*")
        .eq("id", id)
        .single();
      if (!cancelled) {
        setUser(data as KaigoUser | null);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, supabase]);

  if (!id) return null;

  const baseHref = `/users/${id}`;

  // 現在どのサブタブにいるかを判定
  const currentSubHref = (() => {
    const suffix = pathname.slice(baseHref.length); // "", "/care-cert", etc.
    return suffix;
  })();

  // 現在選択されているメイン分類を判定
  const activeMainTab: MainTab = INSURANCE_TABS.some((t) => t.href === currentSubHref)
    ? "insurance"
    : "basic";

  const currentSubs = activeMainTab === "basic" ? BASIC_TABS : INSURANCE_TABS;

  return (
    <div className="space-y-4">
      {/* パンくず */}
      <div className="flex items-center gap-3">
        <Link
          href="/users"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
        >
          <ChevronLeft size={16} />
          利用者一覧
        </Link>
      </div>

      {/* 利用者ヘッダー */}
      <div className="rounded-lg border bg-white p-5 shadow-sm">
        {loading ? (
          <div className="h-14 animate-pulse rounded bg-gray-100" />
        ) : user ? (
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-blue-100">
                <User size={28} className="text-blue-600" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-gray-900">{user.name}</h1>
                <p className="text-sm text-gray-500">{user.name_kana}</p>
                <div className="mt-1 flex items-center gap-2 text-sm text-gray-600">
                  <span>{user.gender}</span>
                  <span>·</span>
                  <span>{differenceInYears(new Date(), parseISO(user.birth_date))}歳</span>
                  <span>·</span>
                  <span>{format(parseISO(user.birth_date), "yyyy年M月d日")} 生</span>
                </div>
              </div>
            </div>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                user.status === "active"
                  ? "bg-green-100 text-green-800"
                  : user.status === "deceased"
                    ? "bg-red-100 text-red-700"
                    : "bg-gray-100 text-gray-600"
              }`}
            >
              {STATUS_LABELS[user.status] ?? user.status}
            </span>
          </div>
        ) : (
          <p className="text-sm text-gray-400">利用者情報を取得できませんでした</p>
        )}
      </div>

      {/* 2大タブ */}
      <div className="flex gap-1 border-b border-gray-200">
        {([
          { id: "basic" as const, label: "基本情報", defaultHref: "" },
          { id: "insurance" as const, label: "介護保険", defaultHref: "/care-cert" },
        ]).map((main) => {
          const isActive = activeMainTab === main.id;
          return (
            <Link
              key={main.id}
              href={baseHref + main.defaultHref}
              className={`rounded-t-lg px-5 py-2.5 text-sm font-semibold transition-colors ${
                isActive
                  ? "bg-white text-blue-700 border border-gray-200 border-b-white -mb-px shadow-sm"
                  : "bg-gray-50 text-gray-500 hover:text-gray-700 hover:bg-gray-100"
              }`}
            >
              {main.label}
            </Link>
          );
        })}
      </div>

      {/* サブタブ */}
      <div className="border-b bg-white rounded-t-lg shadow-sm overflow-x-auto -mt-4 pt-1">
        <nav className="flex min-w-max">
          {currentSubs.map((tab) => {
            const isActive = tab.href === currentSubHref;
            return (
              <Link
                key={tab.href}
                href={baseHref + tab.href}
                className={`px-4 py-2.5 text-[13px] font-medium whitespace-nowrap border-b-2 transition-colors ${
                  isActive
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* 各サブページのコンテンツ */}
      {children}
    </div>
  );
}
