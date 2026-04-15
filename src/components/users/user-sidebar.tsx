"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { Search, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBusinessType } from "@/lib/business-type-context";

interface KaigoUser {
  id: string;
  name: string;
  name_kana: string;
  status: string;
}

interface UserSidebarProps {
  selectedUserId: string | null;
  onSelectUser: (userId: string) => void;
}

const FILTER_KEY = "kaigo.user_filter_mode";

export function UserSidebar({ selectedUserId, onSelectUser }: UserSidebarProps) {
  const [users, setUsers] = useState<KaigoUser[]>([]);
  const [officeUserIds, setOfficeUserIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const supabase = useMemo(() => createClient(), []);
  const { currentOfficeId } = useBusinessType();

  // 表示モード: all (全利用者) / office (自事業所の利用者のみ)
  const [filterMode, setFilterMode] = useState<"all" | "office">(() => {
    if (typeof window === "undefined") return "office";
    const stored = localStorage.getItem(FILTER_KEY);
    return stored === "all" ? "all" : "office";
  });

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("kaigo_users")
      .select("id, name, name_kana, status")
      .eq("status", "active")
      .order("name_kana", { ascending: true });
    const list = (data || []) as KaigoUser[];
    setUsers(list);

    // 自事業所に紐付く利用者を取得
    if (currentOfficeId) {
      const { data: svc } = await supabase
        .from("kaigo_user_office_services")
        .select("user_id")
        .eq("office_id", currentOfficeId)
        .eq("is_active", true);
      const set = new Set<string>((svc || []).map((s: { user_id: string }) => s.user_id));
      setOfficeUserIds(set);
    } else {
      setOfficeUserIds(new Set());
    }
    setLoading(false);
  }, [supabase, currentOfficeId]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  useEffect(() => {
    if (!loading && !selectedUserId && users.length > 0) {
      onSelectUser(users[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, users]);

  const filtered = useMemo(() => {
    let list = users;
    if (filterMode === "office" && currentOfficeId) {
      list = list.filter((u) => officeUserIds.has(u.id));
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((u) =>
        u.name.toLowerCase().includes(q) || u.name_kana.toLowerCase().includes(q)
      );
    }
    return list;
  }, [users, search, filterMode, currentOfficeId, officeUserIds]);

  const setMode = (m: "all" | "office") => {
    setFilterMode(m);
    if (typeof window !== "undefined") localStorage.setItem(FILTER_KEY, m);
  };

  return (
    <div className="flex h-full w-36 flex-col border-r bg-white">
      <div className="border-b p-2 space-y-1.5">
        <div className="relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="利用者検索"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md border bg-gray-50 py-1.5 pl-7 pr-2 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        {/* フィルタ切替 */}
        <div className="flex rounded-md border overflow-hidden text-[10px] font-medium">
          <button
            onClick={() => setMode("office")}
            className={cn(
              "flex-1 py-1 transition-colors",
              filterMode === "office" ? "bg-blue-600 text-white" : "bg-gray-50 text-gray-500 hover:bg-gray-100"
            )}
          >
            自事業所
          </button>
          <button
            onClick={() => setMode("all")}
            className={cn(
              "flex-1 py-1 transition-colors",
              filterMode === "all" ? "bg-blue-600 text-white" : "bg-gray-50 text-gray-500 hover:bg-gray-100"
            )}
          >
            全利用者
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-3 text-center text-xs text-gray-400">読込中...</div>
        ) : filtered.length === 0 ? (
          <div className="p-3 text-center text-xs text-gray-400">
            {filterMode === "office" ? "自事業所の利用者なし" : "該当なし"}
          </div>
        ) : (
          <ul className="py-1">
            {filtered.map((user) => (
              <li key={user.id}>
                <button
                  onClick={() => onSelectUser(user.id)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
                    selectedUserId === user.id
                      ? "bg-blue-50 text-blue-700 font-medium border-r-2 border-blue-600"
                      : "text-gray-700 hover:bg-gray-50"
                  )}
                >
                  <User size={14} className="shrink-0 text-gray-400" />
                  <div className="min-w-0">
                    <div className="truncate text-sm leading-tight">{user.name}</div>
                    <div className="truncate text-[10px] text-gray-400 leading-tight">{user.name_kana}</div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="border-t px-3 py-1.5 text-[10px] text-gray-400">
        {filtered.length}名
      </div>
    </div>
  );
}
