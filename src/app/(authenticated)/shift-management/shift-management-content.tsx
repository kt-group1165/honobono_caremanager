"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resolvePreferredTenantId } from "@/lib/tenant-resolver";
import { toast } from "sonner";
import {
  CalendarDays,
  Clock,
  Download,
  Link2,
  Search,
  User,
  Users,
  UserCog,
  X,
  Copy,
  Check,
  Loader2,
  FileText,
} from "lucide-react";
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  getDay,
  parseISO,
} from "date-fns";
import { ja } from "date-fns/locale";
import { cn } from "@/lib/utils";
import {
  type KaigoStaff,
  type KaigoUser,
  type SidebarTab,
  type StaffToken,
  type ViewMode,
  type VisitPattern,
  type VisitSchedule,
} from "./_shared";
import { UserCalendar, type UserCalendarInitialData } from "./user-calendar-content";
import { StaffCalendar, type StaffCalendarInitialData } from "./staff-calendar-content";
import { TimelineView, type TimelineInitialData } from "./timeline-view-content";
import { MonthlyIndividualView, type MonthlyIndividualInitialData } from "./monthly-individual-content";

// ─── Sidebar ──────────────────────────────────────────────────────────────────

interface DualSidebarProps {
  tab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  users: KaigoUser[];
  staff: KaigoStaff[];
  selectedUserId: string | null;
  selectedStaffId: string | null;
  onSelectUser: (id: string) => void;
  onSelectStaff: (id: string) => void;
}

function DualSidebar({
  tab,
  onTabChange,
  users,
  staff,
  selectedUserId,
  selectedStaffId,
  onSelectUser,
  onSelectStaff,
}: DualSidebarProps) {
  const [search, setSearch] = useState("");

  const filteredUsers = useMemo(() => {
    if (!search) return users;
    const q = search.toLowerCase();
    return users.filter(
      (u) => u.name.toLowerCase().includes(q) || u.name_kana.toLowerCase().includes(q)
    );
  }, [users, search]);

  const filteredStaff = useMemo(() => {
    if (!search) return staff;
    const q = search.toLowerCase();
    return staff.filter(
      (s) => s.name.toLowerCase().includes(q) || s.name_kana.toLowerCase().includes(q)
    );
  }, [staff, search]);

  const list = tab === "user" ? filteredUsers : filteredStaff;
  const count = tab === "user" ? filteredUsers.length : filteredStaff.length;

  return (
    <div className="flex h-full w-40 flex-col border-r bg-white">
      <div className="flex border-b">
        <button
          onClick={() => { onTabChange("user"); setSearch(""); }}
          className={cn(
            "flex-1 py-2 text-xs font-medium transition-colors",
            tab === "user"
              ? "border-b-2 border-blue-600 text-blue-700"
              : "text-gray-500 hover:text-gray-700"
          )}
        >
          <Users size={12} className="mx-auto mb-0.5" />
          利用者
        </button>
        <button
          onClick={() => { onTabChange("staff"); setSearch(""); }}
          className={cn(
            "flex-1 py-2 text-xs font-medium transition-colors",
            tab === "staff"
              ? "border-b-2 border-blue-600 text-blue-700"
              : "text-gray-500 hover:text-gray-700"
          )}
        >
          <UserCog size={12} className="mx-auto mb-0.5" />
          職員
        </button>
      </div>
      <div className="border-b p-2">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="検索"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded border bg-gray-50 py-1 pl-6 pr-2 text-xs focus:border-blue-500 focus:outline-none"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {list.length === 0 ? (
          <div className="p-3 text-center text-xs text-gray-400">該当なし</div>
        ) : (
          <ul className="py-1">
            {list.map((item) => {
              const isSelected =
                tab === "user" ? selectedUserId === item.id : selectedStaffId === item.id;
              const icon = tab === "user" ? <User size={12} /> : <UserCog size={12} />;
              return (
                <li key={item.id}>
                  <button
                    onClick={() =>
                      tab === "user" ? onSelectUser(item.id) : onSelectStaff(item.id)
                    }
                    className={cn(
                      "flex w-full items-center gap-1.5 px-2 py-2 text-left transition-colors",
                      isSelected
                        ? "bg-blue-50 text-blue-700 font-medium border-r-2 border-blue-600"
                        : "text-gray-700 hover:bg-gray-50"
                    )}
                  >
                    <span className="shrink-0 text-gray-400">{icon}</span>
                    <div className="min-w-0">
                      <div className="truncate text-xs leading-tight">{item.name}</div>
                      <div className="truncate text-[10px] text-gray-400 leading-tight">
                        {item.name_kana}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="border-t px-2 py-1 text-[10px] text-gray-400">{count}名</div>
    </div>
  );
}

// ─── Pattern Import Modal ──────────────────────────────────────────────────────

function PatternImportModal({ onClose }: { onClose: () => void }) {
  const supabase = useMemo(() => createClient(), []);
  const [selectedMonth, setSelectedMonth] = useState(
    format(new Date(), "yyyy-MM")
  );
  const [patterns, setPatterns] = useState<VisitPattern[]>([]);
  const [users, setUsers] = useState<KaigoUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [weekChecks, setWeekChecks] = useState<Record<string, Record<number, boolean>>>({});
  const [userChecks, setUserChecks] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const fetch = async () => {
      setLoading(true);
      const [patRes, userRes] = await Promise.all([
        supabase
          .from("kaigo_visit_patterns")
          .select("id, user_id, pattern_name, day_of_week, start_time, end_time, service_type, staff_id, clients(name)")
          .order("user_id"),
        supabase.from("clients").select("id, name, name_kana:furigana, status").eq("status", "active").eq("is_facility", false),
      ]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
      const pats: VisitPattern[] = (patRes.data || []).map((r: any) => ({
        ...r,
        user_name: r.clients?.name ?? null,
      }));
      setPatterns(pats);
      setUsers(userRes.data || []);
      const checks: Record<string, Record<number, boolean>> = {};
      const uChecks: Record<string, boolean> = {};
      const userIds = [...new Set(pats.map((p) => p.user_id))];
      for (const uid of userIds) {
        checks[uid] = { 1: true, 2: true, 3: true, 4: true, 5: true };
        uChecks[uid] = false;
      }
      setWeekChecks(checks);
      setUserChecks(uChecks);
      setLoading(false);
    };
    fetch();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const usersWithPatterns = useMemo(() => {
    const ids = [...new Set(patterns.map((p) => p.user_id))];
    return ids.map((id) => ({
      user: users.find((u) => u.id === id) ?? { id, name: "不明", name_kana: "", status: "active" },
      patterns: patterns.filter((p) => p.user_id === id),
    }));
  }, [patterns, users]);

  const weeksInMonth = useMemo(() => {
    const [y, m] = selectedMonth.split("-").map(Number);
    const start = startOfMonth(new Date(y, m - 1, 1));
    const end = endOfMonth(start);
    const days = eachDayOfInterval({ start, end });
    return days.length >= 29 && getDay(start) >= 4 ? 5 : days.length >= 36 ? 5 : Math.ceil((days.length + getDay(start)) / 7);
  }, [selectedMonth]);

  const toggleWeek = (userId: string, week: number) => {
    setWeekChecks((prev) => ({
      ...prev,
      [userId]: { ...(prev[userId] || {}), [week]: !(prev[userId]?.[week] ?? true) },
    }));
  };

  const doImport = async (userIds: string[]) => {
    setImporting(true);
    try {
      const [y, m] = selectedMonth.split("-").map(Number);
      const monthStart = startOfMonth(new Date(y, m - 1, 1));
      const monthEnd = endOfMonth(monthStart);
      const allDays = eachDayOfInterval({ start: monthStart, end: monthEnd });

      const toInsert: Record<string, unknown>[] = [];

      for (const userId of userIds) {
        const userPatterns = patterns.filter((p) => p.user_id === userId);
        const checks = weekChecks[userId] || {};

        for (const day of allDays) {
          const dow = getDay(day);
          const dayNum = day.getDate();
          const firstOfMonth = getDay(monthStart);
          const weekNum = Math.ceil((dayNum + firstOfMonth) / 7);

          if (!checks[weekNum]) continue;

          const matchingPatterns = userPatterns.filter((p) => p.day_of_week === dow);
          for (const pat of matchingPatterns) {
            toInsert.push({
              user_id: userId,
              staff_id: pat.staff_id,
              visit_date: format(day, "yyyy-MM-dd"),
              start_time: pat.start_time,
              end_time: pat.end_time,
              service_type: pat.service_type,
            });
          }
        }
      }

      if (toInsert.length === 0) {
        toast.info("取り込む予定がありません");
        setImporting(false);
        return;
      }

      const [y2, m2] = selectedMonth.split("-").map(Number);
      const mStart = format(startOfMonth(new Date(y2, m2 - 1, 1)), "yyyy-MM-dd");
      const mEnd = format(endOfMonth(new Date(y2, m2 - 1, 1)), "yyyy-MM-dd");
      for (const userId of userIds) {
        await supabase
          .from("kaigo_visit_schedule")
          .delete()
          .eq("user_id", userId)
          .gte("visit_date", mStart)
          .lte("visit_date", mEnd)
          .eq("status", "scheduled");
      }

      const { error } = await supabase
        .from("kaigo_visit_schedule")
        .insert(toInsert);

      if (error) throw error;
      toast.success(`${toInsert.length}件の予定を取り込みました`);
      onClose();
    } catch (err: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
      toast.error("取り込みに失敗: " + (err instanceof Error ? err.message : typeof err === 'object' && err !== null && 'message' in err ? (err as any).message : JSON.stringify(err)));
    } finally {
      setImporting(false);
    }
  };

  const WEEK_LABELS = ["第1週", "第2週", "第3週", "第4週", "第5週"];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between border-b px-5 py-4 shrink-0">
          <h2 className="font-semibold text-gray-900">パターン取り込み</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-gray-700">対象月:</label>
            <input
              type="month"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="rounded-lg border px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={20} className="animate-spin text-blue-500" />
            </div>
          ) : usersWithPatterns.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">
              パターンが登録されている利用者がいません
            </p>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setUserChecks((prev) => {
                    const next = { ...prev };
                    for (const key of Object.keys(next)) next[key] = true;
                    return next;
                  })}
                  className="text-xs text-blue-600 hover:underline"
                >
                  全員選択
                </button>
                <button
                  onClick={() => setUserChecks((prev) => {
                    const next = { ...prev };
                    for (const key of Object.keys(next)) next[key] = false;
                    return next;
                  })}
                  className="text-xs text-gray-500 hover:underline"
                >
                  全員解除
                </button>
              </div>

              {usersWithPatterns.map(({ user, patterns: upats }) => {
                const isUserChecked = userChecks[user.id] ?? false;
                return (
                  <div key={user.id} className={cn("rounded-lg border p-3 transition-colors", isUserChecked ? "border-blue-300 bg-blue-50/30" : "")}>
                    <div className="flex items-center justify-between mb-2">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isUserChecked}
                          onChange={() => setUserChecks((prev) => ({ ...prev, [user.id]: !prev[user.id] }))}
                          className="rounded w-4 h-4"
                        />
                        <span className="text-sm font-medium text-gray-900">{user.name}</span>
                      </label>
                      <span className="text-xs text-gray-500">
                        {upats.length}パターン
                      </span>
                    </div>
                    {isUserChecked && (
                      <div className="flex gap-3 flex-wrap ml-6">
                        {WEEK_LABELS.slice(0, weeksInMonth).map((label, i) => {
                          const week = i + 1;
                          const checked = weekChecks[user.id]?.[week] ?? true;
                          return (
                            <label key={week} className="flex items-center gap-1 text-xs cursor-pointer">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleWeek(user.id, week)}
                                className="rounded"
                              />
                              {label}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-3 border-t px-5 py-4 shrink-0">
          <button
            onClick={onClose}
            className="rounded-lg border px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            キャンセル
          </button>
          <button
            disabled={importing || !Object.values(userChecks).some(Boolean)}
            onClick={() => {
              const selected = usersWithPatterns
                .filter(({ user }) => userChecks[user.id])
                .map(({ user }) => user.id);
              doImport(selected);
            }}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            {importing && <Loader2 size={14} className="animate-spin" />}
            選択取り込み（{Object.values(userChecks).filter(Boolean).length}名）
          </button>
          <button
            disabled={importing || usersWithPatterns.length === 0}
            onClick={() => doImport(usersWithPatterns.map(({ user }) => user.id))}
            className="rounded-lg bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
          >
            {importing && <Loader2 size={14} className="animate-spin" />}
            全員取り込み
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── URL Management Modal ──────────────────────────────────────────────────────

function UrlManagementModal({ onClose }: { onClose: () => void }) {
  const supabase = useMemo(() => createClient(), []);
  const [staff, setStaff] = useState<KaigoStaff[]>([]);
  const [tokens, setTokens] = useState<StaffToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    const fetch = async () => {
      setLoading(true);
      const [staffRes, tokenRes] = await Promise.all([
        supabase.from("members").select("id, name, name_kana:furigana, status").eq("status", "active").order("furigana", { nullsFirst: false }),
        supabase.from("kaigo_staff_tokens").select("id, staff_id, token"),
      ]);
      setStaff(staffRes.data || []);
      setTokens((tokenRes.data || []) as StaffToken[]);
      setLoading(false);
    };
    fetch();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getToken = (staffId: string) => tokens.find((t) => t.staff_id === staffId);

  const generateUrl = async (staffId: string) => {
    setGenerating(staffId);
    try {
      const token = crypto.randomUUID();
      const existing = getToken(staffId);
      if (existing) {
        const { error } = await supabase
          .from("kaigo_staff_tokens")
          .update({ token })
          .eq("staff_id", staffId);
        if (error) throw error;
      } else {
        const resolved = await resolvePreferredTenantId(supabase);
        if (!resolved.ok) throw new Error(resolved.error);
        const { error } = await supabase
          .from("kaigo_staff_tokens")
          .insert({ staff_id: staffId, token, tenant_id: resolved.tenantId });
        if (error) throw error;
      }
      setTokens((prev) => {
        const filtered = prev.filter((t) => t.staff_id !== staffId);
        return [...filtered, { id: "", staff_id: staffId, token }];
      });
      toast.success("URLを発行しました");
    } catch (err: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
      toast.error("URL発行に失敗: " + (err instanceof Error ? err.message : typeof err === 'object' && err !== null && 'message' in err ? (err as any).message : JSON.stringify(err)));
    } finally {
      setGenerating(null);
    }
  };

  const copyUrl = async (token: string) => {
    const url = `https://kaigo-app-ruddy.vercel.app/staff-availability/${token}`;
    await navigator.clipboard.writeText(url);
    setCopied(token);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-xl flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between border-b px-5 py-4 shrink-0">
          <h2 className="font-semibold text-gray-900">職員URL管理</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto flex-1 p-5">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={20} className="animate-spin text-blue-500" />
            </div>
          ) : (
            <div className="space-y-2">
              {staff.map((s) => {
                const tok = getToken(s.id);
                const url = tok
                  ? `https://kaigo-app-ruddy.vercel.app/staff-availability/${tok.token}`
                  : null;
                return (
                  <div key={s.id} className="rounded-lg border p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-gray-900">{s.name}</span>
                      <button
                        onClick={() => generateUrl(s.id)}
                        disabled={generating === s.id}
                        className="flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {generating === s.id ? (
                          <Loader2 size={10} className="animate-spin" />
                        ) : (
                          <Link2 size={10} />
                        )}
                        {tok ? "再発行" : "URL発行"}
                      </button>
                    </div>
                    {url && (
                      <div className="flex items-center gap-2 mt-1">
                        <span className="flex-1 truncate text-[11px] text-gray-500 bg-gray-50 rounded px-2 py-1 font-mono">
                          {url}
                        </span>
                        <button
                          onClick={() => tok && copyUrl(tok.token)}
                          className="shrink-0 rounded border p-1 hover:bg-gray-50 text-gray-500"
                          title="コピー"
                        >
                          {copied === tok?.token ? (
                            <Check size={12} className="text-green-600" />
                          ) : (
                            <Copy size={12} />
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex justify-end border-t px-5 py-4 shrink-0">
          <button
            onClick={onClose}
            className="rounded-lg border px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Content ──────────────────────────────────────────────────────────

export interface ShiftManagementContentProps {
  initialUsers: KaigoUser[];
  initialStaff: KaigoStaff[];
  initialTab: SidebarTab;
  initialView: ViewMode;
  initialSelectedUserId: string | null;
  initialSelectedStaffId: string | null;
  initialMonthIso: string; // YYYY-MM-01 ISO
  initialDateIso: string; // YYYY-MM-DD ISO
  initialUserCalendarData: UserCalendarInitialData | null;
  initialStaffCalendarData: StaffCalendarInitialData | null;
  initialTimelineData: TimelineInitialData | null;
  initialMonthlyIndividualData: MonthlyIndividualInitialData | null;
}

export function ShiftManagementContent({
  initialUsers,
  initialStaff,
  initialTab,
  initialView,
  initialSelectedUserId,
  initialSelectedStaffId,
  initialMonthIso,
  initialDateIso,
  initialUserCalendarData,
  initialStaffCalendarData,
  initialTimelineData,
  initialMonthlyIndividualData,
}: ShiftManagementContentProps) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [users] = useState<KaigoUser[]>(initialUsers);
  const [staff] = useState<KaigoStaff[]>(initialStaff);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>(initialTab);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(initialSelectedUserId);
  const [selectedStaffId, setSelectedStaffId] = useState<string | null>(initialSelectedStaffId);
  const [currentMonth, setCurrentMonth] = useState(() => new Date(initialMonthIso));
  const [selectedDate, setSelectedDate] = useState(() => new Date(initialDateIso));
  const [viewMode, setViewMode] = useState<ViewMode>(initialView);

  const [showPatternModal, setShowPatternModal] = useState(false);
  const [showUrlModal, setShowUrlModal] = useState(false);
  const [hasPendingChanges, setHasPendingChanges] = useState(false);

  // Page-level edit modal (shared across views)
  const [pageEditModal, setPageEditModal] = useState<VisitSchedule | null>(null);
  const [pageEditForm, setPageEditForm] = useState({ start_time: "", end_time: "", service_type: "", staff_id: "" });
  const [pageEditSaving, setPageEditSaving] = useState(false);

  // Sync filters to URL (replace, no scroll). Skip on initial mount since URL already matches.
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.set("tab", sidebarTab);
    params.set("view", viewMode);
    if (selectedUserId) params.set("user", selectedUserId); else params.delete("user");
    if (selectedStaffId) params.set("staff", selectedStaffId); else params.delete("staff");
    params.set("month", format(currentMonth, "yyyy-MM"));
    params.set("date", format(selectedDate, "yyyy-MM-dd"));
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only sync on filter change
  }, [sidebarTab, viewMode, selectedUserId, selectedStaffId, currentMonth, selectedDate]);

  const openPageEditModal = (sched: VisitSchedule) => {
    setPageEditModal(sched);
    setPageEditForm({
      start_time: sched.start_time?.slice(0, 5) ?? "",
      end_time: sched.end_time?.slice(0, 5) ?? "",
      service_type: sched.service_type ?? "",
      staff_id: sched.staff_id ?? "",
    });
  };

  const handlePageEditSave = async () => {
    if (!pageEditModal) return;
    setPageEditSaving(true);
    const { error } = await supabase
      .from("kaigo_visit_schedule")
      .update({
        start_time: pageEditForm.start_time + ":00",
        end_time: pageEditForm.end_time + ":00",
        service_type: pageEditForm.service_type,
        staff_id: pageEditForm.staff_id || null,
      })
      .eq("id", pageEditModal.id);
    if (error) {
      toast.error("更新に失敗しました: " + error.message);
    } else {
      toast.success("更新しました");
      setPageEditModal(null);
    }
    setPageEditSaving(false);
  };

  const handlePageEditDelete = async () => {
    if (!pageEditModal || !confirm("この予定を削除しますか？")) return;
    const { error } = await supabase
      .from("kaigo_visit_schedule")
      .delete()
      .eq("id", pageEditModal.id);
    if (error) {
      toast.error("削除に失敗しました: " + error.message);
    } else {
      toast.success("削除しました");
      setPageEditModal(null);
    }
  };

  const confirmIfPending = (action: () => void) => {
    if (hasPendingChanges) {
      if (!window.confirm("未保存の変更があります。破棄しますか？")) return;
    }
    action();
  };

  const selectedUser = users.find((u) => u.id === selectedUserId);
  const selectedStaffMember = staff.find((s) => s.id === selectedStaffId);
  const monthKey = format(currentMonth, "yyyy-MM");
  const dateKey = format(selectedDate, "yyyy-MM-dd");

  // 各 sub-component に渡す initial data: SSR で fetch 済み (server prop) のうち
  // 現在の filter と完全一致する場合のみ initial として使用、それ以外は空。
  // Empty initial → ref-skip pattern で false 経路に入り、refetch でクライアント側 fetch。
  const emptyUserCalendarData: UserCalendarInitialData = useMemo(
    () => ({ schedules: [], availability: [], allStaff: [], allProviders: [], allSchedules: [] }),
    []
  );
  const emptyStaffCalendarData: StaffCalendarInitialData = useMemo(
    () => ({ schedules: [], availability: [] }),
    []
  );
  const emptyTimelineData: TimelineInitialData = useMemo(
    () => ({ schedules: [], availability: [] }),
    []
  );
  const emptyMonthlyData: MonthlyIndividualInitialData = useMemo(
    () => ({ schedules: [] }),
    []
  );

  const isUserCalendarMatchingInitial =
    initialView === "calendar" && initialTab === "user"
      && selectedUserId === initialSelectedUserId
      && monthKey === format(new Date(initialMonthIso), "yyyy-MM");
  const isStaffCalendarMatchingInitial =
    ((initialView === "calendar" && initialTab === "staff") ||
      (initialView === "monthly-individual" && initialTab === "staff" && viewMode === "calendar"))
      && selectedStaffId === initialSelectedStaffId
      && monthKey === format(new Date(initialMonthIso), "yyyy-MM");
  const isTimelineMatchingInitial =
    initialView === "timeline"
      && dateKey === format(new Date(initialDateIso), "yyyy-MM-dd");
  const isMonthlyMatchingInitial =
    initialView === "monthly-individual"
      && monthKey === format(new Date(initialMonthIso), "yyyy-MM")
      && (initialTab === "user"
        ? selectedUserId === initialSelectedUserId
        : selectedStaffId === initialSelectedStaffId);

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b bg-white px-4 py-3 shrink-0">
        <div className="flex items-center gap-2">
          <CalendarDays className="text-blue-600" size={22} />
          <h1 className="text-lg font-bold text-gray-900">シフト管理</h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border overflow-hidden">
            <button
              onClick={() => confirmIfPending(() => setViewMode("calendar"))}
              className={cn(
                "flex items-center gap-1 px-3 py-1.5 text-sm font-medium transition-colors",
                viewMode === "calendar"
                  ? "bg-blue-600 text-white"
                  : "bg-white text-gray-600 hover:bg-gray-50"
              )}
            >
              <CalendarDays size={14} />
              カレンダー
            </button>
            <button
              onClick={() => confirmIfPending(() => setViewMode("monthly-individual"))}
              className={cn(
                "flex items-center gap-1 px-3 py-1.5 text-sm font-medium transition-colors",
                viewMode === "monthly-individual"
                  ? "bg-blue-600 text-white"
                  : "bg-white text-gray-600 hover:bg-gray-50"
              )}
            >
              <FileText size={14} />
              月間個別
            </button>
            {sidebarTab === "staff" && (
              <button
                onClick={() => confirmIfPending(() => setViewMode("timeline"))}
                className={cn(
                  "flex items-center gap-1 px-3 py-1.5 text-sm font-medium transition-colors",
                  viewMode === "timeline"
                    ? "bg-blue-600 text-white"
                    : "bg-white text-gray-600 hover:bg-gray-50"
                )}
              >
                <Clock size={14} />
                タイムライン
              </button>
            )}
          </div>
          <button
            onClick={() => setShowPatternModal(true)}
            className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            <Download size={15} />
            パターン取り込み
          </button>
          <button
            onClick={() => setShowUrlModal(true)}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            <Link2 size={15} />
            URL発行
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        <DualSidebar
          tab={sidebarTab}
          onTabChange={(t) => confirmIfPending(() => setSidebarTab(t))}
          users={users}
          staff={staff}
          selectedUserId={selectedUserId}
          selectedStaffId={selectedStaffId}
          onSelectUser={(id) => confirmIfPending(() => {
            setSelectedUserId(id);
            setSidebarTab("user");
          })}
          onSelectStaff={(id) => confirmIfPending(() => {
            setSelectedStaffId(id);
            setSidebarTab("staff");
          })}
        />

        <div className="flex flex-1 flex-col overflow-hidden">
          {viewMode === "timeline" && sidebarTab === "staff" ? (
            <TimelineView
              key={`timeline-${dateKey}`}
              tab={sidebarTab}
              users={users}
              staff={staff}
              selectedDate={selectedDate}
              onDateChange={setSelectedDate}
              currentMonth={currentMonth}
              onMonthChange={setCurrentMonth}
              onPendingChangesChange={setHasPendingChanges}
              onEditSchedule={openPageEditModal}
              initialData={isTimelineMatchingInitial && initialTimelineData
                ? initialTimelineData
                : emptyTimelineData}
            />
          ) : viewMode === "monthly-individual" ? (
            sidebarTab === "user" ? (
              selectedUserId && selectedUser ? (
                <MonthlyIndividualView
                  key={`monthly-user-${selectedUserId}-${monthKey}`}
                  entityId={selectedUserId}
                  entityName={selectedUser.name}
                  entityType="user"
                  currentMonth={currentMonth}
                  onMonthChange={setCurrentMonth}
                  staff={staff}
                  onEditSchedule={openPageEditModal}
                  initialData={isMonthlyMatchingInitial && initialMonthlyIndividualData
                    ? initialMonthlyIndividualData
                    : emptyMonthlyData}
                />
              ) : (
                <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
                  利用者を選択してください
                </div>
              )
            ) : (
              selectedStaffId && selectedStaffMember ? (
                <StaffCalendar
                  key={`staffcal-fallback-${selectedStaffId}-${monthKey}`}
                  staffId={selectedStaffId}
                  staffName={selectedStaffMember.name}
                  currentMonth={currentMonth}
                  onMonthChange={setCurrentMonth}
                  onEditSchedule={openPageEditModal}
                  initialData={isStaffCalendarMatchingInitial && initialStaffCalendarData
                    ? initialStaffCalendarData
                    : emptyStaffCalendarData}
                />
              ) : (
                <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
                  職員を選択してください
                </div>
              )
            )
          ) : sidebarTab === "user" ? (
            selectedUserId && selectedUser ? (
              <UserCalendar
                key={`usercal-${selectedUserId}-${monthKey}`}
                userId={selectedUserId}
                userName={selectedUser.name}
                currentMonth={currentMonth}
                onMonthChange={setCurrentMonth}
                initialData={isUserCalendarMatchingInitial && initialUserCalendarData
                  ? initialUserCalendarData
                  : emptyUserCalendarData}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
                利用者を選択してください
              </div>
            )
          ) : selectedStaffId && selectedStaffMember ? (
            <StaffCalendar
              key={`staffcal-${selectedStaffId}-${monthKey}`}
              staffId={selectedStaffId}
              staffName={selectedStaffMember.name}
              currentMonth={currentMonth}
              onMonthChange={setCurrentMonth}
              onEditSchedule={openPageEditModal}
              initialData={isStaffCalendarMatchingInitial && initialStaffCalendarData
                ? initialStaffCalendarData
                : emptyStaffCalendarData}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
              職員を選択してください
            </div>
          )}
        </div>
      </div>

      {showPatternModal && <PatternImportModal onClose={() => setShowPatternModal(false)} />}
      {showUrlModal && <UrlManagementModal onClose={() => setShowUrlModal(false)} />}

      {pageEditModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setPageEditModal(null)}>
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="font-semibold text-gray-900">予定を編集</h2>
              <button onClick={() => setPageEditModal(null)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">日付</label>
                <div className="font-semibold text-gray-900">
                  {pageEditModal.visit_date ? format(parseISO(pageEditModal.visit_date), "yyyy年M月d日(E)", { locale: ja }) : "—"}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">開始時間</label>
                  <input
                    type="time"
                    value={pageEditForm.start_time}
                    onChange={(e) => setPageEditForm({ ...pageEditForm, start_time: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">終了時間</label>
                  <input
                    type="time"
                    value={pageEditForm.end_time}
                    onChange={(e) => setPageEditForm({ ...pageEditForm, end_time: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">サービス</label>
                <input
                  type="text"
                  value={pageEditForm.service_type}
                  onChange={(e) => setPageEditForm({ ...pageEditForm, service_type: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">担当職員</label>
                <select
                  value={pageEditForm.staff_id}
                  onChange={(e) => setPageEditForm({ ...pageEditForm, staff_id: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                >
                  <option value="">-- 選択 --</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex items-center justify-between border-t px-5 py-4">
              <button
                onClick={handlePageEditDelete}
                className="text-sm text-red-600 hover:underline"
              >
                ✕ 削除
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => setPageEditModal(null)}
                  className="rounded-lg border px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  キャンセル
                </button>
                <button
                  onClick={handlePageEditSave}
                  disabled={pageEditSaving}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
