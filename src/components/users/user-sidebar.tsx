"use client";

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { Search, User } from "lucide-react";
import { cn } from "@/lib/utils";

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

export function UserSidebar({ selectedUserId, onSelectUser }: UserSidebarProps) {
  const [users, setUsers] = useState<KaigoUser[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    const fetchUsers = async () => {
      setLoading(true);
      const { data } = await supabase
        .from("kaigo_users")
        .select("id, name, name_kana, status")
        .eq("status", "active")
        .order("name_kana", { ascending: true });
      setUsers(data || []);
      setLoading(false);
    };
    fetchUsers();
  }, [supabase]);

  const filtered = useMemo(() => {
    if (!search) return users;
    const q = search.toLowerCase();
    return users.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        u.name_kana.toLowerCase().includes(q)
    );
  }, [users, search]);

  return (
    <div className="flex h-full w-36 flex-col border-r bg-white">
      <div className="border-b p-2">
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
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-3 text-center text-xs text-gray-400">読込中...</div>
        ) : filtered.length === 0 ? (
          <div className="p-3 text-center text-xs text-gray-400">該当なし</div>
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
