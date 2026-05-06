"use client";

import { Suspense, useState, useEffect, useMemo, useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Search, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBusinessType } from "@/lib/business-type-context";
import { useLocalStorage } from "@/lib/use-local-storage";

// 利用者一覧表示用の最小スキーマ（共通マスタ clients の subset）
interface ClientRow {
  id: string;
  name: string;
  furigana: string | null;
  status: string;
}

interface UserSidebarProps {
  // Both props omitted → URL mode (?user=<id> driven via search params)
  // Both props provided → explicit mode (used by users/[id]/layout where id is in path)
  selectedUserId?: string | null;
  onSelectUser?: (userId: string) => void;
}

const FILTER_KEY = "kaigo.user_filter_mode";
const URL_PARAM = "user";

// useSearchParams は Suspense 境界配下に必須 (CSR bailout 回避)
// 利用側が Suspense を毎回張らずに済むよう、本体側で内蔵する
export function UserSidebar(props: UserSidebarProps = {}) {
  return (
    <Suspense fallback={<UserSidebarFallback />}>
      <UserSidebarInner {...props} />
    </Suspense>
  );
}

function UserSidebarFallback() {
  return (
    <div className="flex h-full w-36 flex-col border-r bg-white">
      <div className="border-b p-2 space-y-1.5 h-[58px]" />
      <div className="flex-1 overflow-y-auto p-3 text-center text-xs text-gray-400">
        読込中...
      </div>
    </div>
  );
}

function UserSidebarInner(props: UserSidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // URL mode is active when explicit props are not provided
  const explicit = props.selectedUserId !== undefined && props.onSelectUser !== undefined;
  const urlSelectedUserId = searchParams.get(URL_PARAM);
  const selectedUserId = explicit ? (props.selectedUserId ?? null) : urlSelectedUserId;

  const handleSelectUser = useCallback(
    (id: string) => {
      if (explicit) {
        props.onSelectUser?.(id);
        return;
      }
      const next = new URLSearchParams(searchParams.toString());
      next.set(URL_PARAM, id);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [explicit, props, searchParams, router, pathname]
  );

  const [users, setUsers] = useState<ClientRow[]>([]);
  const [officeUserIds, setOfficeUserIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const supabase = useMemo(() => createClient(), []);
  const { currentOfficeId } = useBusinessType();

  // 表示モード: all (全利用者) / office (自事業所の利用者のみ)
  // useLocalStorage で SSR-safe に hydrate (setState-in-effect 不要)
  const [filterMode, setFilterMode] = useLocalStorage<"all" | "office">(
    FILTER_KEY,
    "office",
    (raw) => (raw === "all" ? "all" : "office"),
  );

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    // Supabase の db.max_rows（デフォルト 1000）対策で、
    // 自事業所モードでは「先に assignments を取得 → .in('id', [...])」で
    // 限定 fetch する。これにより 1000 件超のテナントでも漏れなく
    // 自事業所に紐付く利用者が表示される。
    // 全利用者モードは max_rows までで切れるが UX 上許容。
    if (filterMode === "office" && currentOfficeId) {
      // 1) 自事業所の現役 assignments から client_id を取得
      const { data: assigns } = await supabase
        .from("client_office_assignments")
        .select("client_id")
        .eq("office_id", currentOfficeId)
        .is("end_date", null);
      const clientIds = Array.from(
        new Set<string>((assigns || []).map((a: { client_id: string }) => a.client_id))
      );

      if (clientIds.length === 0) {
        setUsers([]);
        setOfficeUserIds(new Set());
        setLoading(false);
        return;
      }

      // 2) その client_id 群だけ clients を fetch
      // is_facility = false: 法人/事業所エントリ（包括支援センター等）を除外
      const { data } = await supabase
        .from("clients")
        .select("id, name, furigana, status")
        .in("id", clientIds)
        .eq("status", "active")
        .eq("is_facility", false)
        .is("deleted_at", null)
        .order("furigana", { ascending: true, nullsFirst: false });
      setUsers((data || []) as ClientRow[]);
      setOfficeUserIds(new Set<string>(clientIds));
    } else {
      // 全利用者モード: 通常の clients 取得（最大 db.max_rows まで）
      // is_facility = false: 法人/事業所エントリを除外
      const { data } = await supabase
        .from("clients")
        .select("id, name, furigana, status")
        .eq("status", "active")
        .eq("is_facility", false)
        .is("deleted_at", null)
        .order("furigana", { ascending: true, nullsFirst: false })
        .range(0, 9999);
      setUsers((data || []) as ClientRow[]);

      // モード切替時のチラつき防止に officeUserIds も並行取得
      if (currentOfficeId) {
        const { data: svc } = await supabase
          .from("client_office_assignments")
          .select("client_id")
          .eq("office_id", currentOfficeId)
          .is("end_date", null);
        const set = new Set<string>((svc || []).map((s: { client_id: string }) => s.client_id));
        setOfficeUserIds(set);
      } else {
        setOfficeUserIds(new Set());
      }
    }
    setLoading(false);
  }, [supabase, currentOfficeId, filterMode]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  const filtered = useMemo(() => {
    let list = users;
    if (filterMode === "office" && currentOfficeId) {
      list = list.filter((u) => officeUserIds.has(u.id));
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((u) =>
        u.name.toLowerCase().includes(q) || (u.furigana ?? "").toLowerCase().includes(q)
      );
    }
    return list;
  }, [users, search, filterMode, currentOfficeId, officeUserIds]);

  // Auto-select 1st visible user when nothing selected (URL mode のみ)
  // 明示モード (users/[id]/layout) は URL の path 側で id が決まるので auto-select 不要
  useEffect(() => {
    if (explicit) return;
    if (loading) return;
    if (selectedUserId) return;
    if (filtered.length === 0) return;
    handleSelectUser(filtered[0].id);
  }, [explicit, loading, selectedUserId, filtered, handleSelectUser]);

  // setFilterMode が localStorage 書き込み込みなので setMode は alias
  const setMode = setFilterMode;

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
                  onClick={() => handleSelectUser(user.id)}
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
                    <div className="truncate text-[10px] text-gray-400 leading-tight">{user.furigana ?? ""}</div>
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
