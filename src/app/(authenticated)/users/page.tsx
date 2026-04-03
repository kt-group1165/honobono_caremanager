"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { differenceInYears, parseISO, format } from "date-fns";
import { Plus, Search, Download, RefreshCw, User } from "lucide-react";
import type { KaigoUser, CareCertification } from "@/types/database";

type UserWithCareLevel = KaigoUser & {
  care_level: string | null;
};

const STATUS_LABELS: Record<string, string> = {
  active: "在籍中",
  inactive: "退所",
  deceased: "死亡",
};

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  inactive: "bg-gray-100 text-gray-600",
  deceased: "bg-red-100 text-red-700",
};

const GENDER_LABELS: Record<string, string> = {
  男: "男",
  女: "女",
};

function calcAge(birthDate: string): number {
  return differenceInYears(new Date(), parseISO(birthDate));
}

export default function UsersPage() {
  const supabase = createClient();
  const [users, setUsers] = useState<UserWithCareLevel[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchText, setSearchText] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("active");

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      let query = supabase
        .from("kaigo_users")
        .select("*")
        .order("name_kana", { ascending: true });

      if (statusFilter !== "all") {
        query = query.eq("status", statusFilter);
      }

      const { data: userData, error: userError } = await query;
      if (userError) throw userError;

      if (!userData || userData.length === 0) {
        setUsers([]);
        return;
      }

      // Fetch latest care certifications for all users
      const userIds = userData.map((u) => u.id);
      const { data: certData } = await supabase
        .from("kaigo_care_certifications")
        .select("user_id, care_level, start_date, end_date")
        .in("user_id", userIds)
        .eq("status", "active")
        .order("start_date", { ascending: false });

      // Map latest cert per user
      const latestCertMap: Record<string, string> = {};
      if (certData) {
        for (const cert of certData) {
          if (!latestCertMap[cert.user_id]) {
            latestCertMap[cert.user_id] = cert.care_level;
          }
        }
      }

      const enriched: UserWithCareLevel[] = userData.map((u) => ({
        ...u,
        care_level: latestCertMap[u.id] ?? null,
      }));

      setUsers(enriched);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "取得に失敗しました";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [supabase, statusFilter]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const filteredUsers = users.filter((u) => {
    if (!searchText) return true;
    const q = searchText.toLowerCase();
    return (
      u.name.toLowerCase().includes(q) ||
      u.name_kana.toLowerCase().includes(q)
    );
  });

  const handleCsvExport = () => {
    if (filteredUsers.length === 0) {
      toast.error("エクスポートするデータがありません");
      return;
    }
    const header = [
      "氏名",
      "氏名（かな）",
      "性別",
      "生年月日",
      "年齢",
      "介護度",
      "ステータス",
    ];
    const rows = filteredUsers.map((u) => [
      u.name,
      u.name_kana,
      u.gender,
      u.birth_date,
      calcAge(u.birth_date).toString(),
      u.care_level ?? "",
      STATUS_LABELS[u.status] ?? u.status,
    ]);
    const csvContent =
      "\uFEFF" +
      [header, ...rows].map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `利用者一覧_${format(new Date(), "yyyyMMdd")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("CSVをエクスポートしました");
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">利用者管理</h1>
          <p className="mt-1 text-sm text-gray-500">
            登録利用者の一覧・管理
          </p>
        </div>
        <Link
          href="/users/new"
          className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
        >
          <Plus size={16} />
          新規登録
        </Link>
      </div>

      {/* Filters */}
      <div className="rounded-lg border bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            {/* Search */}
            <div className="relative">
              <Search
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
              />
              <input
                type="text"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="氏名・かなで検索"
                className="rounded-md border pl-9 pr-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 w-56"
              />
            </div>
            {/* Status filter */}
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-md border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="all">すべてのステータス</option>
              <option value="active">在籍中</option>
              <option value="inactive">退所</option>
              <option value="deceased">死亡</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchUsers}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
            >
              <RefreshCw size={14} />
              更新
            </button>
            <button
              onClick={handleCsvExport}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
            >
              <Download size={14} />
              CSV出力
            </button>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-gray-400">
            <RefreshCw size={20} className="animate-spin mr-2" />
            読み込み中...
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-gray-400">
            <User size={40} className="mb-3 opacity-30" />
            <p className="text-sm">利用者が見つかりません</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="px-4 py-3 text-left font-medium text-gray-600">
                    氏名
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">
                    氏名（かな）
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">
                    性別
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">
                    年齢
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">
                    介護度
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">
                    ステータス
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredUsers.map((user) => (
                  <tr
                    key={user.id}
                    className="hover:bg-gray-50 transition-colors"
                  >
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {user.name}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{user.name_kana}</td>
                    <td className="px-4 py-3 text-gray-600">
                      {GENDER_LABELS[user.gender] ?? user.gender}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {calcAge(user.birth_date)}歳
                    </td>
                    <td className="px-4 py-3">
                      {user.care_level ? (
                        <span className="inline-flex items-center rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-800">
                          {user.care_level}
                        </span>
                      ) : (
                        <span className="text-gray-400 text-xs">未登録</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[user.status] ?? "bg-gray-100 text-gray-600"}`}
                      >
                        {STATUS_LABELS[user.status] ?? user.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/users/${user.id}`}
                        className="text-blue-600 hover:text-blue-800 hover:underline text-sm"
                      >
                        詳細
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t px-4 py-3 text-xs text-gray-500">
              {filteredUsers.length} 件表示
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
