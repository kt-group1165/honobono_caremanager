"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { resolvePreferredTenantId } from "@/lib/tenant-resolver";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  Search,
  User,
  Users,
  UserCog,
  CalendarDays,
  Clock,
  Download,
  Link2,
  X,
  Copy,
  Check,
  Loader2,
  AlertTriangle,
  Save,
  Undo2,
  Plus,
  FileText,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  getDay,
  addMonths,
  subMonths,
  parseISO,
  isSameDay,
} from "date-fns";
import { ja } from "date-fns/locale";
import { cn } from "@/lib/utils";
import { ServiceSelector } from "@/components/services/service-selector";

// ─── Types ────────────────────────────────────────────────────────────────────

interface KaigoUser {
  id: string;
  name: string;
  name_kana: string;
  status: string;
}

interface KaigoStaff {
  id: string;
  name: string;
  name_kana: string;
  status: string;
}

interface VisitSchedule {
  id: string;
  user_id: string;
  staff_id: string | null;
  visit_date: string;
  start_time: string | null;
  end_time: string | null;
  service_type: string;
  status?: string; // scheduled=予定, completed=実績, cancelled, changed
  staff_name?: string | null;
  user_name?: string | null;
  _isCopy?: boolean; // ローカル複写行（未保存）
}

interface StaffAvailabilitySlot {
  staff_id: string;
  available_date: string;
  start_time: string;
  end_time: string;
  is_available: boolean;
}

interface VisitPattern {
  id: string;
  user_id: string;
  pattern_name: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  service_type: string;
  staff_id: string | null;
  staff_name?: string | null;
  user_name?: string | null;
}

interface StaffToken {
  id: string;
  staff_id: string;
  token: string;
  staff_name?: string;
}

const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const SERVICE_TYPE_COLORS: Record<string, string> = {
  身体介護: "bg-blue-100 text-blue-700",
  生活援助: "bg-green-100 text-green-700",
  "身体・生活": "bg-purple-100 text-purple-700",
  通院等乗降介助: "bg-orange-100 text-orange-700",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function isStaffUnavailableAtTime(
  staffId: string,
  dateStr: string,
  startTime: string | null,
  endTime: string | null,
  availability: StaffAvailabilitySlot[]
): boolean {
  if (!startTime) return false;
  const staffSlots = availability.filter((a) => a.staff_id === staffId);
  if (staffSlots.length === 0) return false; // No monthly data at all
  const slots = staffSlots.filter((a) => a.available_date === dateStr);
  if (slots.length === 0) return true; // Has monthly data but no record for this day = unavailable
  const sMin = timeToMinutes(startTime);
  const eMin = endTime ? timeToMinutes(endTime) : sMin + 60;
  // Check if any slot is unavailable that overlaps with schedule time
  for (const slot of slots) {
    if (!slot.is_available) {
      const slotStart = timeToMinutes(slot.start_time);
      const slotEnd = timeToMinutes(slot.end_time);
      if (sMin < slotEnd && eMin > slotStart) return true;
    }
  }
  // If staff has availability records for this date but no slot covers the schedule time, treat as unavailable
  const availableSlots = slots.filter((s) => s.is_available);
  if (slots.length > 0 && availableSlots.length > 0) {
    const covered = availableSlots.some((slot) => {
      const slotStart = timeToMinutes(slot.start_time);
      const slotEnd = timeToMinutes(slot.end_time);
      return slotStart <= sMin && eMin <= slotEnd;
    });
    return !covered;
  }
  return false;
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

type SidebarTab = "user" | "staff";

interface DualSidebarProps {
  tab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  users: KaigoUser[];
  staff: KaigoStaff[];
  selectedUserId: string | null;
  selectedStaffId: string | null;
  onSelectUser: (id: string) => void;
  onSelectStaff: (id: string) => void;
  loading: boolean;
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
  loading,
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
      {/* Tabs */}
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
      {/* Search */}
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
      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-3 text-center text-xs text-gray-400">読込中...</div>
        ) : list.length === 0 ? (
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

// ─── User Calendar ────────────────────────────────────────────────────────────

interface UserCalendarProps {
  userId: string;
  userName: string;
  currentMonth: Date;
  onMonthChange: (d: Date) => void;
}

function UserCalendar({ userId, userName, currentMonth, onMonthChange }: UserCalendarProps) {
  const supabase = createClient();
  const [schedules, setSchedules] = useState<VisitSchedule[]>([]);
  const [availability, setAvailability] = useState<StaffAvailabilitySlot[]>([]);
  const [allStaff, setAllStaff] = useState<KaigoStaff[]>([]);
  const [allProviders, setAllProviders] = useState<{ id: string; provider_name: string }[]>([]);
  const [allSchedules, setAllSchedules] = useState<VisitSchedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [editModal, setEditModal] = useState<VisitSchedule | null>(null);
  const [editForm, setEditForm] = useState({ start_time: "", end_time: "", service_type: "", staff_id: "", service_code: "", service_name: "" });
  const [editSaving, setEditSaving] = useState(false);
  const [editDeleting, setEditDeleting] = useState(false);
  const [showServiceSelector, setShowServiceSelector] = useState(false);
  // Add new schedule
  const [addModal, setAddModal] = useState<string | null>(null); // visit_date string
  const [addForm, setAddForm] = useState({ start_time: "09:00", end_time: "10:00", service_type: "", staff_id: "", service_code: "", service_name: "" });
  const [addSaving, setAddSaving] = useState(false);
  const [showAddServiceSelector, setShowAddServiceSelector] = useState(false);

  const days = useMemo(
    () =>
      eachDayOfInterval({
        start: startOfMonth(currentMonth),
        end: endOfMonth(currentMonth),
      }),
    [currentMonth]
  );

  const fetchData = useCallback(async () => {
    setLoading(true);
    const from = format(startOfMonth(currentMonth), "yyyy-MM-dd");
    const to = format(endOfMonth(currentMonth), "yyyy-MM-dd");

    const [schedRes, availRes, allStaffRes, allSchedRes, provRes] = await Promise.all([
      supabase
        .from("kaigo_visit_schedule")
        .select("id, user_id, staff_id, visit_date, start_time, end_time, service_type, status, members(name)")
        .eq("user_id", userId)
        .gte("visit_date", from)
        .lte("visit_date", to)
        .order("start_time"),
      supabase
        .from("kaigo_staff_availability_monthly")
        .select("staff_id, available_date, start_time, end_time, is_available")
        .gte("available_date", from)
        .lte("available_date", to),
      supabase.from("members").select("id, name, name_kana:furigana, status").eq("status", "active"),
      supabase
        .from("kaigo_visit_schedule")
        .select("id, user_id, staff_id, visit_date, start_time, end_time, service_type")
        .gte("visit_date", from)
        .lte("visit_date", to),
      supabase.from("kaigo_service_providers").select("id, provider_name").eq("status", "active").order("provider_name"),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
    const mapped: VisitSchedule[] = (schedRes.data || []).map((r: any) => ({
      id: r.id,
      user_id: r.user_id,
      staff_id: r.staff_id,
      visit_date: r.visit_date,
      start_time: r.start_time,
      end_time: r.end_time,
      service_type: r.service_type,
      status: r.status ?? "scheduled",
      staff_name: r.members?.name ?? null,
    }));

    setSchedules(mapped);
    setAvailability((availRes.data || []) as StaffAvailabilitySlot[]);
    setAllStaff(allStaffRes.data || []);
    setAllProviders(provRes.data || []);
    setAllSchedules((allSchedRes.data || []) as VisitSchedule[]);
    setLoading(false);
  }, [userId, currentMonth, supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    fetchData();
  }, [fetchData]);

  const isUnavailable = (sched: VisitSchedule) => {
    if (!sched.staff_id) return false;
    return isStaffUnavailableAtTime(
      sched.staff_id,
      sched.visit_date,
      sched.start_time,
      sched.end_time,
      availability
    );
  };

  const openEditModal = (sched: VisitSchedule) => {
    setEditModal(sched);
    setEditForm({
      start_time: sched.start_time?.slice(0, 5) ?? "09:00",
      end_time: sched.end_time?.slice(0, 5) ?? "10:00",
      service_type: sched.service_type,
      staff_id: sched.staff_id ?? "",
      service_code: "",
      service_name: sched.service_type,
    });
  };

  const handleEditSave = async () => {
    if (!editModal) return;
    setEditSaving(true);
    const updateData: Record<string, string | null> = {
      start_time: editForm.start_time + ":00",
      end_time: editForm.end_time + ":00",
      service_type: editForm.service_name || editForm.service_type,
      staff_id: editForm.staff_id || null,
    };
    const { error } = await supabase
      .from("kaigo_visit_schedule")
      .update(updateData)
      .eq("id", editModal.id);
    if (error) {
      toast.error("更新に失敗しました");
    } else {
      toast.success("予定を更新しました");
      setEditModal(null);
      fetchData();
    }
    setEditSaving(false);
  };

  const handleEditDelete = async () => {
    if (!editModal) return;
    if (!window.confirm("この予定を削除しますか？")) return;
    setEditDeleting(true);
    const { error } = await supabase
      .from("kaigo_visit_schedule")
      .delete()
      .eq("id", editModal.id);
    if (error) {
      toast.error("削除に失敗しました");
    } else {
      toast.success("予定を削除しました");
      setEditModal(null);
      fetchData();
    }
    setEditDeleting(false);
  };

  // Staff availability info for edit modal
  const getStaffStatusForEdit = (staffId: string) => {
    if (!editModal || !staffId) return { unavail: false, conflict: false };
    const unavail = isStaffUnavailableAtTime(
      staffId,
      editModal.visit_date,
      editForm.start_time + ":00",
      editForm.end_time + ":00",
      availability
    );
    const conflict = allSchedules.some(
      (sc) =>
        sc.id !== editModal.id &&
        sc.staff_id === staffId &&
        sc.visit_date === editModal.visit_date &&
        sc.start_time === editForm.start_time + ":00"
    );
    return { unavail, conflict };
  };

  const openAddModal = (dateStr: string) => {
    setAddModal(dateStr);
    setAddForm({ start_time: "09:00", end_time: "10:00", service_type: "", staff_id: "", service_code: "", service_name: "" });
  };

  const handleAddSave = async () => {
    if (!addModal) return;
    if (!addForm.service_name) {
      toast.error("サービスを選択してください");
      return;
    }
    setAddSaving(true);
    const { error } = await supabase
      .from("kaigo_visit_schedule")
      .insert({
        user_id: userId,
        visit_date: addModal,
        start_time: addForm.start_time + ":00",
        end_time: addForm.end_time + ":00",
        service_type: addForm.service_name || addForm.service_type,
        staff_id: addForm.staff_id || null,
      });
    if (error) {
      toast.error("追加に失敗しました");
    } else {
      toast.success("予定を追加しました");
      setAddModal(null);
      fetchData();
    }
    setAddSaving(false);
  };

  const getStaffStatusForAdd = (staffId: string) => {
    if (!addModal || !staffId) return { unavail: false, conflict: false };
    const unavail = isStaffUnavailableAtTime(
      staffId, addModal, addForm.start_time + ":00", addForm.end_time + ":00", availability
    );
    const conflict = allSchedules.some(
      (sc) => sc.staff_id === staffId && sc.visit_date === addModal && sc.start_time === addForm.start_time + ":00"
    );
    return { unavail, conflict };
  };

  const firstDow = days.length > 0 ? getDay(days[0]) : 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Month nav */}
      <div className="flex items-center gap-3 px-4 py-3 border-b bg-white">
        <button
          onClick={() => onMonthChange(subMonths(currentMonth, 1))}
          className="rounded border p-1 hover:bg-gray-50"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="min-w-[8rem] text-center font-semibold text-sm text-gray-900">
          {format(currentMonth, "yyyy年M月", { locale: ja })} — {userName}
        </span>
        <button
          onClick={() => onMonthChange(addMonths(currentMonth, 1))}
          className="rounded border p-1 hover:bg-gray-50"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 size={24} className="animate-spin text-blue-500" />
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-3">
          {/* DoW header */}
          <div className="grid grid-cols-7 gap-1 mb-1">
            {DOW_LABELS.map((d, i) => (
              <div
                key={d}
                className={cn(
                  "text-center text-xs font-bold py-1",
                  i === 0 ? "text-red-500" : i === 6 ? "text-blue-500" : "text-gray-500"
                )}
              >
                {d}
              </div>
            ))}
          </div>
          {/* Calendar */}
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: firstDow }).map((_, i) => (
              <div key={`blank-${i}`} className="rounded bg-gray-50 min-h-[80px]" />
            ))}
            {days.map((day) => {
              const dateStr = format(day, "yyyy-MM-dd");
              const dow = getDay(day);
              const daySchedules = schedules.filter((s) => s.visit_date === dateStr);
              const isToday = isSameDay(day, new Date());

              return (
                <div
                  key={dateStr}
                  className={cn(
                    "rounded border min-h-[80px] p-1 text-left",
                    dow === 0 ? "bg-red-50/40" : dow === 6 ? "bg-blue-50/40" : "bg-white"
                  )}
                >
                  <div className="flex items-center justify-between mb-0.5">
                    <span
                      className={cn(
                        "inline-flex h-5 w-5 items-center justify-center rounded-full text-xs font-semibold",
                        isToday
                          ? "bg-blue-600 text-white"
                          : dow === 0
                          ? "text-red-500"
                          : dow === 6
                          ? "text-blue-500"
                          : "text-gray-700"
                      )}
                    >
                      {format(day, "d")}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); openAddModal(dateStr); }}
                      className="w-4 h-4 flex items-center justify-center rounded text-gray-300 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                      title="予定を追加"
                    >
                      <Plus size={12} />
                    </button>
                  </div>
                  <div className="space-y-0.5">
                    {daySchedules.map((sched) => {
                      const unavail = isUnavailable(sched);
                      const isCompleted = sched.status === "completed";
                      return (
                        <button
                          key={sched.id}
                          onClick={() => openEditModal(sched)}
                          className={cn(
                            "w-full text-left rounded px-1 py-0.5 text-[8px] leading-tight whitespace-nowrap overflow-hidden text-ellipsis cursor-pointer transition-colors",
                            unavail
                              ? "bg-yellow-50 text-yellow-700 font-semibold hover:bg-yellow-100"
                              : isCompleted
                              ? "bg-red-50 text-red-600 font-semibold hover:bg-red-100"
                              : "bg-blue-50 text-blue-700 hover:bg-blue-100"
                          )}
                          title={isCompleted ? "実績（クリックして編集）" : "予定（クリックして編集）"}
                        >
                          {sched.start_time?.slice(0, 5)}~{sched.end_time?.slice(0, 5)} {sched.staff_name ?? ""} {sched.service_type}
                          {unavail && <AlertTriangle size={8} className="inline ml-0.5" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Edit Schedule Modal */}
      {editModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="font-semibold text-gray-900">予定を編集</h2>
              <button onClick={() => setEditModal(null)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              {/* Date (read-only) */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">日付</label>
                <p className="text-sm font-semibold text-gray-900">
                  {format(new Date(editModal.visit_date + "T00:00:00"), "yyyy年M月d日(E)", { locale: ja })}
                </p>
              </div>

              {/* Time */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">開始時間</label>
                  <input
                    type="time"
                    value={editForm.start_time}
                    onChange={(e) => { const v = e.target.value; setEditForm((f) => ({ ...f, start_time: v, end_time: f.end_time <= v ? v : f.end_time })); }}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">終了時間</label>
                  <input
                    type="time"
                    value={editForm.end_time}
                    min={editForm.start_time}
                    onChange={(e) => { const v = e.target.value; setEditForm((f) => ({ ...f, end_time: v < f.start_time ? f.start_time : v })); }}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>

              {/* Service type */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">サービス</label>
                <button
                  type="button"
                  onClick={() => setShowServiceSelector(true)}
                  className="w-full flex items-center justify-between rounded-lg border border-gray-300 px-3 py-2 text-sm text-left hover:bg-gray-50 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors"
                >
                  <span className={editForm.service_name ? "text-gray-900" : "text-gray-400"}>
                    {editForm.service_name || "サービスを選択..."}
                  </span>
                  {editForm.service_code && (
                    <span className="text-xs text-gray-400 font-mono">{editForm.service_code}</span>
                  )}
                  {!editForm.service_code && (
                    <ChevronRight size={14} className="text-gray-400" />
                  )}
                </button>
                <ServiceSelector
                  open={showServiceSelector}
                  onClose={() => setShowServiceSelector(false)}
                  onSelect={(service) => {
                    setEditForm((f) => ({
                      ...f,
                      service_type: service.categoryName,
                      service_code: service.code,
                      service_name: service.name,
                    }));
                    setShowServiceSelector(false);
                  }}
                />
              </div>

              {/* Staff */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">担当職員</label>
                <select
                  value={editForm.staff_id}
                  onChange={(e) => setEditForm((f) => ({ ...f, staff_id: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">未割当</option>
                  {allStaff.map((s) => {
                    const status = getStaffStatusForEdit(s.id);
                    return (
                      <option key={s.id} value={s.id}>
                        {s.name}{status.unavail ? " (対応不可)" : status.conflict ? " (重複)" : ""}
                      </option>
                    );
                  })}
                </select>
                {/* Warning if selected staff is unavailable */}
                {editForm.staff_id && (() => {
                  const status = getStaffStatusForEdit(editForm.staff_id);
                  if (status.unavail) return (
                    <p className="mt-1 flex items-center gap-1 text-xs text-red-600">
                      <AlertTriangle size={12} />この職員はこの時間帯は対応不可です
                    </p>
                  );
                  if (status.conflict) return (
                    <p className="mt-1 flex items-center gap-1 text-xs text-amber-600">
                      <AlertTriangle size={12} />この職員は同時間帯に別の予定があります
                    </p>
                  );
                  return null;
                })()}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between border-t px-5 py-4">
              <button
                onClick={handleEditDelete}
                disabled={editSaving || editDeleting}
                className="flex items-center gap-1 rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 transition-colors"
              >
                {editDeleting ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
                削除
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => setEditModal(null)}
                  className="rounded-lg border px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  キャンセル
                </button>
                <button
                  onClick={handleEditSave}
                  disabled={editSaving || editDeleting}
                  className="flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {editSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add Schedule Modal */}
      {addModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="font-semibold text-gray-900">予定を追加</h2>
              <button onClick={() => setAddModal(null)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              {/* Date (read-only) */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">日付</label>
                <p className="text-sm font-semibold text-gray-900">
                  {format(new Date(addModal + "T00:00:00"), "yyyy年M月d日(E)", { locale: ja })}
                </p>
              </div>

              {/* Time */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">開始時間</label>
                  <input
                    type="time"
                    value={addForm.start_time}
                    onChange={(e) => { const v = e.target.value; setAddForm((f) => ({ ...f, start_time: v, end_time: f.end_time <= v ? v : f.end_time })); }}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">終了時間</label>
                  <input
                    type="time"
                    value={addForm.end_time}
                    min={addForm.start_time}
                    onChange={(e) => { const v = e.target.value; setAddForm((f) => ({ ...f, end_time: v < f.start_time ? f.start_time : v })); }}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>

              {/* Service */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">サービス</label>
                <button
                  type="button"
                  onClick={() => setShowAddServiceSelector(true)}
                  className="w-full flex items-center justify-between rounded-lg border border-gray-300 px-3 py-2 text-sm text-left hover:bg-gray-50 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors"
                >
                  <span className={addForm.service_name ? "text-gray-900" : "text-gray-400"}>
                    {addForm.service_name || "サービスを選択..."}
                  </span>
                  {addForm.service_code ? (
                    <span className="text-xs text-gray-400 font-mono">{addForm.service_code}</span>
                  ) : (
                    <ChevronRight size={14} className="text-gray-400" />
                  )}
                </button>
                <ServiceSelector
                  open={showAddServiceSelector}
                  onClose={() => setShowAddServiceSelector(false)}
                  onSelect={(service) => {
                    setAddForm((f) => ({
                      ...f,
                      service_type: service.categoryName,
                      service_code: service.code,
                      service_name: service.name,
                    }));
                    setShowAddServiceSelector(false);
                  }}
                />
              </div>

              {/* Staff */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">担当職員</label>
                <select
                  value={addForm.staff_id}
                  onChange={(e) => setAddForm((f) => ({ ...f, staff_id: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">未割当</option>
                  {allStaff.map((s) => {
                    const status = getStaffStatusForAdd(s.id);
                    return (
                      <option key={s.id} value={s.id}>
                        {s.name}{status.unavail ? " (対応不可)" : status.conflict ? " (重複)" : ""}
                      </option>
                    );
                  })}
                </select>
                {addForm.staff_id && (() => {
                  const status = getStaffStatusForAdd(addForm.staff_id);
                  if (status.unavail) return (
                    <p className="mt-1 flex items-center gap-1 text-xs text-red-600">
                      <AlertTriangle size={12} />この職員はこの時間帯は対応不可です
                    </p>
                  );
                  if (status.conflict) return (
                    <p className="mt-1 flex items-center gap-1 text-xs text-amber-600">
                      <AlertTriangle size={12} />この職員は同時間帯に別の予定があります
                    </p>
                  );
                  return null;
                })()}
              </div>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 border-t px-5 py-4">
              <button
                onClick={() => setAddModal(null)}
                className="rounded-lg border px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                キャンセル
              </button>
              <button
                onClick={handleAddSave}
                disabled={addSaving}
                className="flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {addSaving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                追加
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Staff Calendar ───────────────────────────────────────────────────────────

interface StaffCalendarProps {
  staffId: string;
  staffName: string;
  currentMonth: Date;
  onMonthChange: (d: Date) => void;
  onEditSchedule?: (sched: VisitSchedule) => void;
}

function StaffCalendar({ staffId, staffName, currentMonth, onMonthChange, onEditSchedule }: StaffCalendarProps) {
  const supabase = createClient();
  const [schedules, setSchedules] = useState<VisitSchedule[]>([]);
  const [availability, setAvailability] = useState<StaffAvailabilitySlot[]>([]);
  const [loading, setLoading] = useState(false);

  const days = useMemo(
    () =>
      eachDayOfInterval({
        start: startOfMonth(currentMonth),
        end: endOfMonth(currentMonth),
      }),
    [currentMonth]
  );

  const fetchData = useCallback(async () => {
    setLoading(true);
    const from = format(startOfMonth(currentMonth), "yyyy-MM-dd");
    const to = format(endOfMonth(currentMonth), "yyyy-MM-dd");

    const [schedRes, availRes] = await Promise.all([
      supabase
        .from("kaigo_visit_schedule")
        .select("id, user_id, staff_id, visit_date, start_time, end_time, service_type, status, clients(name)")
        .eq("staff_id", staffId)
        .gte("visit_date", from)
        .lte("visit_date", to)
        .order("start_time"),
      supabase
        .from("kaigo_staff_availability_monthly")
        .select("staff_id, available_date, start_time, end_time, is_available")
        .eq("staff_id", staffId)
        .gte("available_date", from)
        .lte("available_date", to),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
    const mapped: VisitSchedule[] = (schedRes.data || []).map((r: any) => ({
      id: r.id,
      user_id: r.user_id,
      staff_id: r.staff_id,
      visit_date: r.visit_date,
      start_time: r.start_time,
      end_time: r.end_time,
      service_type: r.service_type,
      status: r.status ?? "scheduled",
      user_name: r.clients?.name ?? null,
    }));

    setSchedules(mapped);
    setAvailability((availRes.data || []) as StaffAvailabilitySlot[]);
    setLoading(false);
  }, [staffId, currentMonth, supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    fetchData();
  }, [fetchData]);

  const isDayUnavailable = (dateStr: string) => {
    // If staff has ANY monthly records, days without records are unavailable
    if (availability.length === 0) return false; // No monthly data at all → don't grey out
    const slots = availability.filter((a) => a.available_date === dateStr);
    if (slots.length === 0) return true; // No record for this day → unavailable
    return slots.every((s) => !s.is_available);
  };

  const isScheduleConflict = (sched: VisitSchedule) => {
    return schedules.some(
      (s) =>
        s.id !== sched.id &&
        s.visit_date === sched.visit_date &&
        s.start_time === sched.start_time
    );
  };

  const isScheduleOnUnavailableSlot = (sched: VisitSchedule) => {
    return isStaffUnavailableAtTime(
      staffId,
      sched.visit_date,
      sched.start_time,
      sched.end_time,
      availability
    );
  };

  const firstDow = days.length > 0 ? getDay(days[0]) : 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Month nav */}
      <div className="flex items-center gap-3 px-4 py-3 border-b bg-white">
        <button
          onClick={() => onMonthChange(subMonths(currentMonth, 1))}
          className="rounded border p-1 hover:bg-gray-50"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="min-w-[8rem] text-center font-semibold text-sm text-gray-900">
          {format(currentMonth, "yyyy年M月", { locale: ja })} — {staffName}
        </span>
        <button
          onClick={() => onMonthChange(addMonths(currentMonth, 1))}
          className="rounded border p-1 hover:bg-gray-50"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 size={24} className="animate-spin text-blue-500" />
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-3">
          {/* DoW header */}
          <div className="grid grid-cols-7 gap-1 mb-1">
            {DOW_LABELS.map((d, i) => (
              <div
                key={d}
                className={cn(
                  "text-center text-xs font-bold py-1",
                  i === 0 ? "text-red-500" : i === 6 ? "text-blue-500" : "text-gray-500"
                )}
              >
                {d}
              </div>
            ))}
          </div>
          {/* Calendar */}
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: firstDow }).map((_, i) => (
              <div key={`blank-${i}`} className="rounded bg-gray-50 min-h-[80px]" />
            ))}
            {days.map((day) => {
              const dateStr = format(day, "yyyy-MM-dd");
              const dow = getDay(day);
              const daySchedules = schedules.filter((s) => s.visit_date === dateStr);
              const dayUnavail = isDayUnavailable(dateStr);
              const isToday = isSameDay(day, new Date());

              return (
                <div
                  key={dateStr}
                  className={cn(
                    "rounded border min-h-[80px] p-1",
                    dayUnavail ? "bg-gray-200" : dow === 0 ? "bg-red-50/40" : dow === 6 ? "bg-blue-50/40" : "bg-white"
                  )}
                >
                  <span
                    className={cn(
                      "inline-flex h-5 w-5 items-center justify-center rounded-full text-xs font-semibold mb-0.5",
                      isToday
                        ? "bg-blue-600 text-white"
                        : dow === 0
                        ? "text-red-500"
                        : dow === 6
                        ? "text-blue-500"
                        : dayUnavail
                        ? "text-gray-400"
                        : "text-gray-700"
                    )}
                  >
                    {format(day, "d")}
                  </span>
                  {/* Grey background indicates unavailable - no text needed */}
                  <div className="space-y-0.5">
                    {daySchedules.map((sched) => {
                      const onUnavail = isScheduleOnUnavailableSlot(sched);
                      const conflict = isScheduleConflict(sched);
                      const isCompleted = sched.status === "completed";
                      const col =
                        SERVICE_TYPE_COLORS[sched.service_type] ?? "bg-gray-100 text-gray-700";
                      return (
                        <button
                          key={sched.id}
                          onClick={() => onEditSchedule?.(sched)}
                          className={cn(
                            "w-full text-left rounded px-1 py-0.5 text-[8px] leading-tight whitespace-nowrap overflow-hidden text-ellipsis cursor-pointer transition-colors",
                            onUnavail || conflict
                              ? "bg-yellow-50 text-yellow-700 font-semibold hover:bg-yellow-100"  // 勤務不可=黄色
                              : isCompleted
                              ? "bg-red-50 text-red-600 font-semibold hover:bg-red-100"  // 実績=赤字
                              : cn(col, "hover:opacity-80")  // 予定=通常色
                          )}
                          title={`クリックして編集${isCompleted ? "（実績）" : "（予定）"}${onUnavail ? " ⚠勤務不可" : ""}`}
                        >
                          {sched.start_time?.slice(0, 5)}~{sched.end_time?.slice(0, 5)} {sched.user_name ?? ""} {sched.service_type}
                          {(onUnavail || conflict) && <AlertTriangle size={8} className="inline ml-0.5" />}
                          {conflict && <span className="ml-0.5">重複</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Summary */}
          <div className="mt-3 rounded-lg border bg-gray-50 px-4 py-2 text-sm text-gray-600">
            今月の訪問件数:{" "}
            <span className="font-semibold text-gray-900">{schedules.length}件</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Pattern Import Modal ──────────────────────────────────────────────────────

interface PatternImportModalProps {
  onClose: () => void;
}

function PatternImportModal({ onClose }: PatternImportModalProps) {
  const supabase = createClient();
  const [selectedMonth, setSelectedMonth] = useState(
    format(new Date(), "yyyy-MM")
  );
  const [patterns, setPatterns] = useState<VisitPattern[]>([]);
  const [users, setUsers] = useState<KaigoUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  // { userId: { 1: true, 2: true, ... } }
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
      // Initialize checks: all weeks checked, all users unchecked
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

  // Compute how many weeks in the selected month
  const weeksInMonth = useMemo(() => {
    const [y, m] = selectedMonth.split("-").map(Number);
    const start = startOfMonth(new Date(y, m - 1, 1));
    const end = endOfMonth(start);
    const days = eachDayOfInterval({ start, end });
    // Week 5 exists if there are 29+ days starting at certain DoW
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
          const dow = getDay(day); // 0=Sun ... 6=Sat
          const dayNum = day.getDate();
          // Determine which week this day belongs to (1-based)
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

      // 既存の予定を削除してから挿入（重複防止）
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
          {/* Month selector */}
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
              {/* Select all / deselect all */}
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

interface UrlManagementModalProps {
  onClose: () => void;
}

function UrlManagementModal({ onClose }: UrlManagementModalProps) {
  const supabase = createClient();
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
        // 既存 token は UPDATE のみ。tenant_id は変えない（admin が tenant を
        // 跨いで運用しない前提、Phase 2-6c migration で NOT NULL 化済）。
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

// ─── Timeline View ───────────────────────────────────────────────────────────

interface PendingChange {
  type: "update" | "copy";
  schedId: string;
  updates: Record<string, string>;
  // For copy: full data needed to insert a new record
  copyData?: Record<string, string | null>;
}

const TIMELINE_START_HOUR = 0;
const TIMELINE_END_HOUR = 24;
const TIMELINE_DEFAULT_SCROLL_HOUR = 8;
const TIMELINE_HOURS = Array.from(
  { length: TIMELINE_END_HOUR - TIMELINE_START_HOUR },
  (_, i) => TIMELINE_START_HOUR + i
);
const TIMELINE_TOTAL_MINUTES =
  (TIMELINE_END_HOUR - TIMELINE_START_HOUR) * 60;

const SERVICE_BAR_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  身体介護: { bg: "bg-orange-100", border: "border-orange-300", text: "text-orange-800" },
  生活援助: { bg: "bg-green-100", border: "border-green-300", text: "text-green-800" },
  "身体・生活": { bg: "bg-purple-100", border: "border-purple-300", text: "text-purple-800" },
  通院等乗降介助: { bg: "bg-cyan-100", border: "border-cyan-300", text: "text-cyan-800" },
};

function getBarStyle(startTime: string | null, endTime: string | null) {
  if (!startTime) return { left: "0%", width: "0%" };
  const sMin = timeToMinutes(startTime) - TIMELINE_START_HOUR * 60;
  const eMin = endTime
    ? timeToMinutes(endTime) - TIMELINE_START_HOUR * 60
    : sMin + 60;
  const left = Math.max(0, (sMin / TIMELINE_TOTAL_MINUTES) * 100);
  const width = Math.min(
    100 - left,
    ((eMin - Math.max(sMin, 0)) / TIMELINE_TOTAL_MINUTES) * 100
  );
  return { left: `${left}%`, width: `${Math.max(width, 1)}%` };
}

type ViewMode = "calendar" | "timeline" | "monthly-individual";

interface TimelineViewProps {
  tab: SidebarTab;
  users: KaigoUser[];
  staff: KaigoStaff[];
  selectedDate: Date;
  onDateChange: (d: Date) => void;
  currentMonth: Date;
  onMonthChange: (d: Date) => void;
  onPendingChangesChange?: (hasPending: boolean) => void;
  onEditSchedule?: (sched: VisitSchedule) => void;
}

function TimelineView({
  tab,
  users,
  staff,
  selectedDate,
  onDateChange,
  currentMonth,
  onMonthChange,
  onPendingChangesChange,
  onEditSchedule,
}: TimelineViewProps) {
  const supabase = createClient();
  const [schedules, setSchedules] = useState<VisitSchedule[]>([]);
  const [availability, setAvailability] = useState<StaffAvailabilitySlot[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const timelineScrollRef = useRef<HTMLDivElement>(null);

  // ─── Pending changes (saved on button click) ──────────────────────
  const [pendingChanges, setPendingChanges] = useState<PendingChange[]>([]);

  // Notify parent & guard browser navigation when pending changes exist
  useEffect(() => {
    onPendingChangesChange?.(pendingChanges.length > 0);
  }, [pendingChanges.length, onPendingChangesChange]);

  useEffect(() => {
    if (pendingChanges.length === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [pendingChanges.length]);

  // ─── Drag-and-drop state ───────────────────────────────────────────
  const [dragging, setDragging] = useState<{
    schedId: string;
    origRowId: string;
    origStartTime: string | null;
    origEndTime: string | null;
    origServiceType: string;
    mouseStartX: number;
    mouseStartY: number;
    barContainerRect: DOMRect;
    rowHeight: number;
    rowStartY: number; // Y position of the first row's top
  } | null>(null);
  const [dragPreview, setDragPreview] = useState<{
    rowIndex: number;
    left: number; // percentage
    width: number; // percentage
  } | null>(null);
  const draggingRef = useRef(dragging);
  // render 時に ref へ最新 state を mirror する pattern。drag handler 内で stale
  // closure を避けるための定石だが React Compiler refs rule は警告するため抑止。
  // eslint-disable-next-line react-hooks/refs
  draggingRef.current = dragging;

  // ─── Move/Copy choice dialog after drop ───────────────────────────
  const [dragDropChoice, setDragDropChoice] = useState<{
    schedId: string;
    origSchedule: VisitSchedule;
    updateData: Record<string, string>;
    newRowId: string;
    newStartTime: string;
    newEndTime: string;
  } | null>(null);

  const dateStr = format(selectedDate, "yyyy-MM-dd");

  const fetchData = useCallback(async () => {
    setLoading(true);
    const [schedRes, availRes] = await Promise.all([
      supabase
        .from("kaigo_visit_schedule")
        .select(
          "id, user_id, staff_id, visit_date, start_time, end_time, service_type, members(name), clients(name)"
        )
        .eq("visit_date", dateStr)
        .order("start_time"),
      supabase
        .from("kaigo_staff_availability_monthly")
        .select("staff_id, available_date, start_time, end_time, is_available")
        .gte("available_date", format(startOfMonth(selectedDate), "yyyy-MM-dd"))
        .lte("available_date", format(endOfMonth(selectedDate), "yyyy-MM-dd")),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
    const mapped: VisitSchedule[] = (schedRes.data || []).map((r: any) => ({
      id: r.id,
      user_id: r.user_id,
      staff_id: r.staff_id,
      visit_date: r.visit_date,
      start_time: r.start_time,
      end_time: r.end_time,
      service_type: r.service_type,
      staff_name: r.members?.name ?? null,
      user_name: r.clients?.name ?? null,
    }));

    setSchedules(mapped);
    setAvailability((availRes.data || []) as StaffAvailabilitySlot[]);
    setLoading(false);
  }, [dateStr, supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    fetchData();
  }, [fetchData]);

  // Scroll to 8:00 by default
  useEffect(() => {
    if (timelineScrollRef.current && !loading) {
      const scrollPct = TIMELINE_DEFAULT_SCROLL_HOUR / 24;
      timelineScrollRef.current.scrollLeft = timelineScrollRef.current.scrollWidth * scrollPct;
    }
  }, [loading]);

  // Build rows based on tab — show ALL users/staff, not just those with schedules
  const rows = useMemo(() => {
    if (tab === "user") {
      return users.map((u) => ({
        id: u.id,
        name: u.name,
        schedules: schedules.filter((s) => s.user_id === u.id),
      }));
    } else {
      return staff.map((s) => ({
        id: s.id,
        name: s.name,
        schedules: schedules.filter((sc) => sc.staff_id === s.id),
      }));
    }
  }, [tab, schedules, users, staff]);

  // For staff view: determine unavailable hour ranges
  const getUnavailableRanges = (staffId: string) => {
    const staffAllSlots = availability.filter((a) => a.staff_id === staffId);
    if (staffAllSlots.length === 0) return []; // No monthly data at all
    const daySlots = staffAllSlots.filter((a) => a.available_date === dateStr);
    if (daySlots.length === 0) {
      // Has monthly data but no record for this day = entire day unavailable
      return [{ left: "0%", width: "100%" }];
    }
    const unavailSlots = daySlots.filter((a) => !a.is_available);
    return unavailSlots.map((slot) => {
      const sMin = timeToMinutes(slot.start_time) - TIMELINE_START_HOUR * 60;
      const eMin = timeToMinutes(slot.end_time) - TIMELINE_START_HOUR * 60;
      const left = Math.max(0, (sMin / TIMELINE_TOTAL_MINUTES) * 100);
      const width = Math.min(
        100 - left,
        ((eMin - Math.max(sMin, 0)) / TIMELINE_TOTAL_MINUTES) * 100
      );
      return { left: `${left}%`, width: `${width}%` };
    });
  };

  // ─── Drag handlers ──────────────────────────────────────────────────
  const handleBarMouseDown = useCallback(
    (
      e: React.MouseEvent,
      sched: VisitSchedule,
      rowId: string,
      barContainerEl: HTMLElement
    ) => {
      e.preventDefault();
      e.stopPropagation();
      const containerRect = barContainerEl.getBoundingClientRect();
      // Find the rows container: walk up to find the rows wrapper
      const rowsContainer = barContainerEl.closest("[data-timeline-rows]");
      const rowEls = rowsContainer
        ? Array.from(rowsContainer.querySelectorAll("[data-row-id]"))
        : [];
      const firstRowRect = rowEls[0]?.getBoundingClientRect();
      const rowHeight = rowEls.length > 1
        ? rowEls[1].getBoundingClientRect().top - rowEls[0].getBoundingClientRect().top
        : firstRowRect?.height ?? 40;

      setDragging({
        schedId: sched.id,
        origRowId: rowId,
        origStartTime: sched.start_time,
        origEndTime: sched.end_time,
        origServiceType: sched.service_type,
        mouseStartX: e.clientX,
        mouseStartY: e.clientY,
        barContainerRect: containerRect,
        rowHeight,
        rowStartY: firstRowRect?.top ?? containerRect.top,
      });

      // Initial preview position
      const style = getBarStyle(sched.start_time, sched.end_time);
      const rowIndex = rows.findIndex((r) => r.id === rowId);
      setDragPreview({
        rowIndex,
        left: parseFloat(style.left),
        width: parseFloat(style.width),
      });
    },
    [rows]
  );

  const handleTimelineMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const drag = draggingRef.current;
      if (!drag) return;

      const deltaX = e.clientX - drag.mouseStartX;
      const deltaY = e.clientY - drag.mouseStartY;

      // Calculate new horizontal position (percentage)
      const containerWidth = drag.barContainerRect.width;
      const deltaPercent = (deltaX / containerWidth) * 100;

      // Original bar left/width
      const origStyle = getBarStyle(drag.origStartTime, drag.origEndTime);
      const origLeft = parseFloat(origStyle.left);
      const origWidth = parseFloat(origStyle.width);

      // Snap to 15-min intervals: each 15 min = (15 / TIMELINE_TOTAL_MINUTES) * 100 percent
      const snapPercent = (15 / TIMELINE_TOTAL_MINUTES) * 100;
      let newLeft = origLeft + deltaPercent;
      newLeft = Math.round(newLeft / snapPercent) * snapPercent;
      newLeft = Math.max(0, Math.min(100 - origWidth, newLeft));

      // Calculate row index from vertical mouse position
      const mouseY = e.clientY;
      let rowIndex = Math.floor((mouseY - drag.rowStartY) / drag.rowHeight);
      rowIndex = Math.max(0, Math.min(rows.length - 1, rowIndex));

      setDragPreview({ rowIndex, left: newLeft, width: origWidth });
    },
    [rows.length]
  );

  const handleTimelineMouseUp = useCallback(
    async (e: React.MouseEvent) => {
      const drag = draggingRef.current;
      const preview = dragPreview;
      if (!drag || !preview) {
        setDragging(null);
        setDragPreview(null);
        return;
      }

      setDragging(null);
      setDragPreview(null);

      // Convert preview left% back to time
      const newStartMinutes =
        (preview.left / 100) * TIMELINE_TOTAL_MINUTES + TIMELINE_START_HOUR * 60;
      const durationMinutes =
        (preview.width / 100) * TIMELINE_TOTAL_MINUTES;
      const newEndMinutes = newStartMinutes + durationMinutes;

      // Snap to 15-min
      const snappedStart = Math.round(newStartMinutes / 15) * 15;
      const snappedEnd = Math.round(newEndMinutes / 15) * 15;

      const formatTime = (totalMins: number) => {
        const h = Math.floor(totalMins / 60);
        const m = totalMins % 60;
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
      };

      const newStartTime = formatTime(snappedStart);
      const newEndTime = formatTime(snappedEnd);
      const targetRow = rows[preview.rowIndex];
      const newRowId = targetRow?.id ?? drag.origRowId;

      // Determine which field to update based on tab
      const rowField = tab === "user" ? "user_id" : "staff_id";

      // Check if anything actually changed
      const origStartStr = drag.origStartTime;
      const origEndStr = drag.origEndTime;
      const timeChanged =
        newStartTime !== origStartStr || newEndTime !== origEndStr;
      const rowChanged = newRowId !== drag.origRowId;

      if (!timeChanged && !rowChanged) return;

      // Build update data
      const updateData: Record<string, string> = {};
      if (timeChanged) {
        updateData.start_time = newStartTime;
        updateData.end_time = newEndTime;
      }
      if (rowChanged) {
        updateData[rowField] = newRowId;
      }

      // Find the original schedule object
      const origSchedule = schedules.find((s) => s.id === drag.schedId);
      if (!origSchedule) return;

      // Show move/copy choice dialog
      setDragDropChoice({
        schedId: drag.schedId,
        origSchedule,
        updateData,
        newRowId,
        newStartTime,
        newEndTime,
      });
    },
    [dragPreview, rows, tab, supabase, fetchData]
  );

  // ─── Handle Move/Copy choice ───────────────────────────────────────
  const handleDragChoiceMove = useCallback(() => {
    if (!dragDropChoice) return;
    const { schedId, updateData } = dragDropChoice;

    // Add to pending changes as update
    setPendingChanges((prev) => {
      const existing = prev.find((p) => p.schedId === schedId);
      if (existing) {
        return prev.map((p) =>
          p.schedId === schedId
            ? { ...p, updates: { ...p.updates, ...updateData } }
            : p
        );
      }
      return [...prev, { type: "update", schedId, updates: updateData }];
    });

    // Apply locally
    setSchedules((prev) =>
      prev.map((s) => {
        if (s.id !== schedId) return s;
        const updated = { ...s };
        if (updateData.start_time) updated.start_time = updateData.start_time;
        if (updateData.end_time) updated.end_time = updateData.end_time;
        if (updateData.user_id) updated.user_id = updateData.user_id;
        if (updateData.staff_id) updated.staff_id = updateData.staff_id;
        return updated;
      })
    );

    setDragDropChoice(null);
    toast.info("移動 — 保存ボタンで確定してください");
  }, [dragDropChoice]);

  const handleDragChoiceCopy = useCallback(() => {
    if (!dragDropChoice) return;
    const { origSchedule, newStartTime, newEndTime, newRowId } = dragDropChoice;
    const rowField = tab === "user" ? "user_id" : "staff_id";

    // Build copy data: same schedule but at new position
    const copyData: Record<string, string | null> = {
      user_id: origSchedule.user_id,
      staff_id: origSchedule.staff_id,
      visit_date: origSchedule.visit_date,
      start_time: newStartTime,
      end_time: newEndTime,
      service_type: origSchedule.service_type,
    };
    // Override the row field with the new target
    copyData[rowField] = newRowId;

    const tempId = "temp-" + Math.random().toString(36).slice(2);

    setPendingChanges((prev) => [
      ...prev,
      { type: "copy", schedId: tempId, updates: {}, copyData },
    ]);

    // Add locally for visual feedback
    const targetRow = rows.find((r) => r.id === newRowId);
    setSchedules((prev) => [
      ...prev,
      {
        id: tempId,
        user_id: copyData.user_id as string,
        staff_id: copyData.staff_id,
        visit_date: copyData.visit_date as string,
        start_time: newStartTime,
        end_time: newEndTime,
        service_type: origSchedule.service_type,
        staff_name: tab === "staff" ? targetRow?.name : origSchedule.staff_name,
        user_name: tab === "user" ? targetRow?.name : origSchedule.user_name,
      },
    ]);

    setDragDropChoice(null);
    toast.info("コピー — 保存ボタンで確定してください");
  }, [dragDropChoice, rows, tab]);

  // ─── Save / Discard pending changes ────────────────────────────────
  const handleSavePendingChanges = useCallback(async () => {
    if (pendingChanges.length === 0) return;
    setSaving(true);
    let hasError = false;
    for (const change of pendingChanges) {
      if (change.type === "copy" && change.copyData) {
        const { error } = await supabase
          .from("kaigo_visit_schedule")
          .insert(change.copyData);
        if (error) {
          console.error(error);
          hasError = true;
        }
      } else {
        const { error } = await supabase
          .from("kaigo_visit_schedule")
          .update(change.updates)
          .eq("id", change.schedId);
        if (error) {
          console.error(error);
          hasError = true;
        }
      }
    }
    if (hasError) {
      toast.error("一部の変更の保存に失敗しました");
    } else {
      toast.success(`${pendingChanges.length}件の変更を保存しました`);
    }
    setPendingChanges([]);
    setSaving(false);
    fetchData();
  }, [pendingChanges, supabase, fetchData]);

  const handleDiscardPendingChanges = useCallback(() => {
    setPendingChanges([]);
    fetchData();
  }, [fetchData]);

  // Cancel drag on escape or mouse leaving window
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && draggingRef.current) {
        setDragging(null);
        setDragPreview(null);
      }
    };
    const handleMouseUp = () => {
      // If mouse up happens outside timeline, cancel drag
      if (draggingRef.current) {
        setDragging(null);
        setDragPreview(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  // Calendar days for date picker
  const days = useMemo(
    () =>
      eachDayOfInterval({
        start: startOfMonth(currentMonth),
        end: endOfMonth(currentMonth),
      }),
    [currentMonth]
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header with date navigation */}
      <div className="flex items-center gap-3 px-4 py-3 border-b bg-white">
        <button
          onClick={() => onMonthChange(subMonths(currentMonth, 1))}
          className="rounded border p-1 hover:bg-gray-50"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="min-w-[6rem] text-center font-semibold text-sm text-gray-900">
          {format(currentMonth, "yyyy年M月", { locale: ja })}
        </span>
        <button
          onClick={() => onMonthChange(addMonths(currentMonth, 1))}
          className="rounded border p-1 hover:bg-gray-50"
        >
          <ChevronRight size={16} />
        </button>
        <div className="ml-2 text-sm text-gray-600">
          選択日: <span className="font-semibold text-gray-900">{format(selectedDate, "M月d日(E)", { locale: ja })}</span>
        </div>
        {pendingChanges.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-amber-600 font-medium">
              {pendingChanges.length}件の未保存の変更
            </span>
            <button
              onClick={handleDiscardPendingChanges}
              disabled={saving}
              className="flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
            >
              <Undo2 size={14} />
              取消
            </button>
            <button
              onClick={handleSavePendingChanges}
              disabled={saving}
              className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              保存
            </button>
          </div>
        )}
      </div>

      {/* Mini date selector strip */}
      <div className="flex items-center gap-1 px-4 py-2 border-b bg-gray-50 overflow-x-auto">
        {days.map((day) => {
          const ds = format(day, "yyyy-MM-dd");
          const isSelected = ds === dateStr;
          const dow = getDay(day);
          const isToday = isSameDay(day, new Date());
          return (
            <button
              key={ds}
              onClick={() => {
                if (pendingChanges.length > 0) {
                  if (!window.confirm("未保存の変更があります。破棄して日付を変更しますか？")) return;
                  setPendingChanges([]);
                }
                onDateChange(day);
              }}
              className={cn(
                "flex flex-col items-center rounded px-1.5 py-1 text-[10px] leading-tight min-w-[2rem] transition-colors",
                isSelected
                  ? "bg-blue-600 text-white"
                  : isToday
                  ? "bg-blue-50 text-blue-700 hover:bg-blue-100"
                  : dow === 0
                  ? "text-red-500 hover:bg-red-50"
                  : dow === 6
                  ? "text-blue-500 hover:bg-blue-50"
                  : "text-gray-600 hover:bg-gray-100"
              )}
            >
              <span className="font-bold">{format(day, "d")}</span>
              <span>{DOW_LABELS[dow]}</span>
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 size={24} className="animate-spin text-blue-500" />
        </div>
      ) : (
        <div className="flex-1 overflow-auto" ref={timelineScrollRef}>
          {/* Timeline grid - 24h wide, scrollable */}
          <div
            style={{ minWidth: "1800px", cursor: dragging ? "grabbing" : undefined }}
            onMouseMove={dragging ? handleTimelineMouseMove : undefined}
            onMouseUp={dragging ? handleTimelineMouseUp : undefined}
          >
            {/* Time header */}
            <div className="flex border-b bg-gray-50 sticky top-0 z-10">
              <div className="w-28 shrink-0 border-r sticky left-0 z-30 bg-gray-50 px-2 py-2 text-xs font-semibold text-gray-600">
                {tab === "user" ? "利用者" : "職員"}
              </div>
              <div className="flex-1 relative">
                <div className="flex h-full">
                  {TIMELINE_HOURS.map((h) => (
                    <div key={h} className="flex-1 border-l border-gray-300" />
                  ))}
                  <div className="border-l border-gray-300" />
                </div>
                <div className="absolute inset-0 flex">
                  {TIMELINE_HOURS.map((h) => (
                    <div
                      key={h}
                      className="flex-1 py-1 text-[10px] font-medium text-gray-500"
                      style={{ paddingLeft: "2px" }}
                    >
                      {h}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Rows */}
            <div data-timeline-rows>
            {rows.map((row, rowIdx) => (
              <div key={row.id} className="flex border-b hover:bg-gray-50/50" data-row-id={row.id}>
                {/* Name column */}
                <div className="w-28 shrink-0 border-r sticky left-0 z-20 bg-white px-2 py-2 text-xs font-medium text-gray-800 truncate flex items-center">
                  {row.name}
                </div>
                {/* Timeline bar area */}
                <div className="flex-1 relative" style={{ minHeight: "2.5rem" }}>
                  {/* Hour grid lines */}
                  <div className="absolute inset-0 flex pointer-events-none">
                    {TIMELINE_HOURS.map((h) => (
                      <div key={h} className="flex-1 border-r border-gray-100" />
                    ))}
                  </div>

                  {/* Unavailable ranges (staff view) */}
                  {tab === "staff" &&
                    getUnavailableRanges(row.id).map((range, i) => (
                      <div
                        key={`unavail-${i}`}
                        className="absolute top-0 bottom-0 bg-gray-200/60"
                        style={{ left: range.left, width: range.width }}
                        title="対応不可"
                      />
                    ))}

                  {/* Schedule bars */}
                  <div className="absolute inset-0" data-bar-container={row.id}>
                    {row.schedules.map((sched) => {
                      const style = getBarStyle(sched.start_time, sched.end_time);
                      const colors =
                        SERVICE_BAR_COLORS[sched.service_type] ?? {
                          bg: "bg-gray-100",
                          border: "border-gray-300",
                          text: "text-gray-700",
                        };
                      const label =
                        tab === "user"
                          ? sched.staff_name ?? "未割当"
                          : sched.user_name ?? "不明";
                      // Check if this schedule is on unavailable time
                      const staffIdForCheck = tab === "staff" ? row.id : sched.staff_id;
                      const isOnUnavail = staffIdForCheck
                        ? isStaffUnavailableAtTime(staffIdForCheck, dateStr, sched.start_time, sched.end_time, availability)
                        : false;
                      const isDraggingThis = dragging?.schedId === sched.id;
                      return (
                        <div
                          key={sched.id}
                          className={cn(
                            "absolute rounded border px-1 text-[10px] leading-tight overflow-hidden flex flex-col justify-center select-none",
                            isOnUnavail
                              ? "bg-red-50 border-red-400 text-red-600 font-semibold"
                              : cn(colors.bg, colors.border, colors.text),
                            isDraggingThis ? "opacity-40" : ""
                          )}
                          style={{
                            left: style.left,
                            width: style.width,
                            top: 0,
                            bottom: 0,
                            cursor: dragging ? "grabbing" : "grab",
                            zIndex: isDraggingThis ? 5 : undefined,
                          }}
                          title={`${sched.start_time?.slice(0, 5)}~${sched.end_time?.slice(0, 5)} ${label} ${sched.service_type}${isOnUnavail ? " ⚠勤務不可" : ""}\nダブルクリックで編集`}
                          onMouseDown={(e) => {
                            const container = e.currentTarget.parentElement;
                            if (container) handleBarMouseDown(e, sched, row.id, container);
                          }}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            onEditSchedule?.(sched);
                          }}
                        >
                          <span className="truncate font-semibold">{isOnUnavail && "⚠ "}{label}</span>
                          <span className="truncate">{sched.service_type}</span>
                        </div>
                      );
                    })}

                    {/* Drag preview ghost bar */}
                    {dragging && dragPreview && dragPreview.rowIndex === rowIdx && (
                      <div
                        className="absolute rounded border-2 border-blue-500 bg-blue-200/50 pointer-events-none"
                        style={{
                          left: `${dragPreview.left}%`,
                          width: `${dragPreview.width}%`,
                          top: 0,
                          bottom: 0,
                          zIndex: 10,
                        }}
                      />
                    )}
                  </div>
                </div>
              </div>
            ))}
            </div>
          </div>

          {/* Legend */}
          <div className="flex items-center gap-4 px-4 py-2 border-t bg-gray-50 text-[10px]">
            {Object.entries(SERVICE_BAR_COLORS).map(([type, colors]) => (
              <div key={type} className="flex items-center gap-1">
                <div className={cn("w-3 h-3 rounded border", colors.bg, colors.border)} />
                <span className="text-gray-600">{type}</span>
              </div>
            ))}
            {tab === "staff" && (
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 rounded bg-gray-200 border border-gray-300" />
                <span className="text-gray-600">対応不可</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Move/Copy choice dialog */}
      {dragDropChoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-xs rounded-xl bg-white shadow-xl">
            <div className="px-5 py-4 border-b">
              <h2 className="font-semibold text-gray-900 text-center">移動 or コピー</h2>
            </div>
            <div className="p-5 space-y-3">
              <button
                onClick={handleDragChoiceMove}
                className="w-full flex items-center gap-3 rounded-lg border border-gray-200 px-4 py-3 text-sm font-medium text-gray-900 hover:bg-blue-50 hover:border-blue-300 transition-colors"
              >
                <span className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 shrink-0">
                  <ChevronRight size={16} />
                </span>
                <div className="text-left">
                  <div className="font-semibold">移動</div>
                  <div className="text-xs text-gray-500">予定を新しい位置に移動</div>
                </div>
              </button>
              <button
                onClick={handleDragChoiceCopy}
                className="w-full flex items-center gap-3 rounded-lg border border-gray-200 px-4 py-3 text-sm font-medium text-gray-900 hover:bg-green-50 hover:border-green-300 transition-colors"
              >
                <span className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center text-green-600 shrink-0">
                  <Copy size={16} />
                </span>
                <div className="text-left">
                  <div className="font-semibold">コピー</div>
                  <div className="text-xs text-gray-500">元の予定を残して複製（担当2人体制）</div>
                </div>
              </button>
            </div>
            <div className="flex justify-center border-t px-5 py-3">
              <button
                onClick={() => setDragDropChoice(null)}
                className="rounded-lg border px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 月間個別ビュー ─────────────────────────────────────────────────────────

interface MonthlyIndividualViewProps {
  entityId: string;
  entityName: string;
  entityType: "user" | "staff";
  currentMonth: Date;
  onMonthChange: (d: Date) => void;
  staff: KaigoStaff[];
  onEditSchedule?: (sched: VisitSchedule) => void;
}

function MonthlyIndividualView({
  entityId,
  entityName,
  entityType,
  currentMonth,
  onMonthChange,
  staff,
  onEditSchedule,
}: MonthlyIndividualViewProps) {
  const supabase = createClient();
  const [schedules, setSchedules] = useState<VisitSchedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkProcessing, setBulkProcessing] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const from = format(startOfMonth(currentMonth), "yyyy-MM-dd");
    const to = format(endOfMonth(currentMonth), "yyyy-MM-dd");

    const col = entityType === "user" ? "user_id" : "staff_id";
    const { data } = await supabase
      .from("kaigo_visit_schedule")
      .select("id, user_id, staff_id, visit_date, start_time, end_time, service_type, status, clients(name), members(name)")
      .eq(col, entityId)
      .gte("visit_date", from)
      .lte("visit_date", to)
      .order("visit_date")
      .order("start_time");

    const mapped: VisitSchedule[] = (data || []).map((r: any) => ({  // eslint-disable-line @typescript-eslint/no-explicit-any
      id: r.id, user_id: r.user_id, staff_id: r.staff_id,
      visit_date: r.visit_date, start_time: r.start_time, end_time: r.end_time,
      service_type: r.service_type, status: r.status ?? "scheduled",
      user_name: r.clients?.name ?? null, staff_name: r.members?.name ?? null,
    }));
    setSchedules(mapped);
    setLoading(false);
  }, [entityId, entityType, currentMonth, supabase]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
  useEffect(() => { fetchData(); }, [fetchData]);

  // 予定⇔実績 切替
  // 予定⇔実績 切替
  // 予定(kaigo_visit_schedule)は常に残す。実績は kaigo_visit_records に追加/削除のみ。
  // → 提供表で予定=1、実績=1の両方が入る
  const toggleStatus = async (sched: VisitSchedule) => {
    const isCurrentlyCompleted = sched.status === "completed";
    setTogglingId(sched.id);

    if (!isCurrentlyCompleted) {
      // 予定→実績: visit_records に INSERT（予定の schedule はそのまま残す）
      const { data: existing } = await supabase
        .from("kaigo_visit_records")
        .select("id")
        .eq("user_id", sched.user_id)
        .eq("visit_date", sched.visit_date)
        .eq("start_time", sched.start_time)
        .limit(1);
      if (!existing || existing.length === 0) {
        const { error } = await supabase.from("kaigo_visit_records").insert({
          user_id: sched.user_id,
          staff_id: sched.staff_id,
          visit_date: sched.visit_date,
          start_time: sched.start_time,
          end_time: sched.end_time,
          service_type: sched.service_type,
          status: "completed",
        });
        if (error) {
          toast.error("実績登録に失敗しました: " + error.message);
          console.error("visit_records insert error:", error);
          setTogglingId(null);
          return;
        }
      }
      // schedule の status も更新（表示用）ただし予定自体は削除しない
      await supabase.from("kaigo_visit_schedule").update({ status: "completed" }).eq("id", sched.id);
      setSchedules((prev) => prev.map((s) => s.id === sched.id ? { ...s, status: "completed" } : s));
      toast.success("実績に変更しました（提供表にも反映）");
    } else {
      // 実績→予定に戻す: visit_records から DELETE（schedule は残す）
      await supabase
        .from("kaigo_visit_records")
        .delete()
        .eq("user_id", sched.user_id)
        .eq("visit_date", sched.visit_date)
        .eq("start_time", sched.start_time);
      await supabase.from("kaigo_visit_schedule").update({ status: "scheduled" }).eq("id", sched.id);
      setSchedules((prev) => prev.map((s) => s.id === sched.id ? { ...s, status: "scheduled" } : s));
      toast.success("予定に戻しました（提供表の実績も削除）");
    }
    setTogglingId(null);
  };

  // 選択の切替
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => {
    if (selectedIds.size === schedules.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(schedules.map((s) => s.id)));
    }
  };

  // 一括: 実績変換
  const bulkToCompleted = async () => {
    if (selectedIds.size === 0) { toast.error("対象を選択してください"); return; }
    const targets = schedules.filter((s) => selectedIds.has(s.id) && s.status !== "completed");
    if (targets.length === 0) { toast.info("選択された予定はすべて実績済みです"); return; }
    setBulkProcessing(true);
    for (const sched of targets) {
      const { data: existing } = await supabase
        .from("kaigo_visit_records").select("id")
        .eq("user_id", sched.user_id).eq("visit_date", sched.visit_date).eq("start_time", sched.start_time).limit(1);
      if (!existing || existing.length === 0) {
        await supabase.from("kaigo_visit_records").insert({
          user_id: sched.user_id, staff_id: sched.staff_id,
          visit_date: sched.visit_date, start_time: sched.start_time, end_time: sched.end_time,
          service_type: sched.service_type, status: "completed",
        });
      }
      await supabase.from("kaigo_visit_schedule").update({ status: "completed" }).eq("id", sched.id);
    }
    setSchedules((prev) => prev.map((s) => selectedIds.has(s.id) ? { ...s, status: "completed" } : s));
    toast.success(`${targets.length}件を実績に変換しました`);
    setSelectedIds(new Set());
    setBulkProcessing(false);
  };

  // 一括: 予定に戻す
  const bulkToScheduled = async () => {
    if (selectedIds.size === 0) { toast.error("対象を選択してください"); return; }
    const targets = schedules.filter((s) => selectedIds.has(s.id) && s.status === "completed");
    if (targets.length === 0) { toast.info("選択された予定はすべて予定状態です"); return; }
    setBulkProcessing(true);
    for (const sched of targets) {
      await supabase.from("kaigo_visit_records").delete()
        .eq("user_id", sched.user_id).eq("visit_date", sched.visit_date).eq("start_time", sched.start_time);
      await supabase.from("kaigo_visit_schedule").update({ status: "scheduled" }).eq("id", sched.id);
    }
    setSchedules((prev) => prev.map((s) => selectedIds.has(s.id) ? { ...s, status: "scheduled" } : s));
    toast.success(`${targets.length}件を予定に戻しました`);
    setSelectedIds(new Set());
    setBulkProcessing(false);
  };

  // 一括: 複写（行のすぐ下に日付なしでコピーを挿入）
  // 実績は複写不可。予定のみ。
  const bulkCopy = () => {
    if (selectedIds.size === 0) { toast.error("対象を選択してください"); return; }
    const targets = schedules.filter((s) => selectedIds.has(s.id) && s.status !== "completed");
    if (targets.length === 0) { toast.error("予定のみ複写できます（実績は不可）"); return; }
    // 各対象行のすぐ下にコピー行を挿入（日付なし）
    const newSchedules: VisitSchedule[] = [];
    for (const sched of schedules) {
      newSchedules.push(sched);
      if (targets.some((t) => t.id === sched.id)) {
        // コピー行（日付なし、_isCopy フラグ付き）
        const copyId = `copy-${sched.id}-${Date.now()}`;
        newSchedules.push({
          ...sched,
          id: copyId,
          visit_date: "", // 日付なし
          status: "scheduled",
          _isCopy: true,
        });
      }
    }
    setSchedules(newSchedules);
    setSelectedIds(new Set());
    toast.success(`${targets.length}件を複写しました（日付を設定してください）`);
  };

  // コピー行に日付を設定してDBに保存
  const saveCopyDate = async (copyRow: VisitSchedule, dateStr: string) => {
    const { data, error } = await supabase.from("kaigo_visit_schedule").insert({
      user_id: copyRow.user_id, staff_id: copyRow.staff_id,
      visit_date: dateStr,
      start_time: copyRow.start_time, end_time: copyRow.end_time,
      service_type: copyRow.service_type, status: "scheduled",
    }).select("id").single();
    if (error) {
      toast.error("保存に失敗しました");
      return;
    }
    // ローカル更新: コピー行を正式な行に変換
    setSchedules((prev) => prev.map((s) =>
      s.id === copyRow.id ? { ...s, id: data.id, visit_date: dateStr, _isCopy: false } : s
    ));
    toast.success("予定を保存しました");
  };

  // コピー行を削除（キャンセル）
  const removeCopyRow = (copyId: string) => {
    setSchedules((prev) => prev.filter((s) => s.id !== copyId));
  };

  // 一括: 削除
  const bulkDelete = async () => {
    if (selectedIds.size === 0) { toast.error("対象を選択してください"); return; }
    const ok = window.confirm(`選択された${selectedIds.size}件を削除します。\n予定も実績も削除されますが、本当によろしいですか？`);
    if (!ok) return;
    setBulkProcessing(true);
    const targets = schedules.filter((s) => selectedIds.has(s.id));
    for (const sched of targets) {
      // 実績も削除
      await supabase.from("kaigo_visit_records").delete()
        .eq("user_id", sched.user_id).eq("visit_date", sched.visit_date).eq("start_time", sched.start_time);
      // 予定を削除
      await supabase.from("kaigo_visit_schedule").delete().eq("id", sched.id);
    }
    setSchedules((prev) => prev.filter((s) => !selectedIds.has(s.id)));
    toast.success(`${targets.length}件を削除しました`);
    setSelectedIds(new Set());
    setBulkProcessing(false);
  };

  const dowStr = (dateStr: string) => {
    try { return format(parseISO(dateStr), "E", { locale: ja }); } catch { return ""; }
  };

  const durationText = (start: string | null, end: string | null) => {
    if (!start || !end) return "";
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    const totalMins = (eh * 60 + em) - (sh * 60 + sm);
    if (totalMins <= 0) return "";
    const h = (totalMins / 60).toFixed(1);
    const units = Math.ceil(totalMins / 30); // 30分=1単位想定
    return `(${h}h-${totalMins / 60 < 1 ? "0.5h" : h + "h"})  ${units * 100}単位`;
  };

  const durationShort = (start: string | null, end: string | null) => {
    if (!start || !end) return "";
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    const totalMins = (eh * 60 + em) - (sh * 60 + sm);
    if (totalMins <= 0) return "";
    return `(${(totalMins / 60).toFixed(1)}h)`;
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ヘッダー: 月ナビ + 件数 */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-white">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-gray-900">{entityName}</span>
          <button onClick={() => onMonthChange(subMonths(currentMonth, 1))} className="rounded border p-1 hover:bg-gray-50"><ChevronLeft size={14} /></button>
          <span className="text-sm font-semibold">{format(currentMonth, "yyyy年M月", { locale: ja })}</span>
          <button onClick={() => onMonthChange(addMonths(currentMonth, 1))} className="rounded border p-1 hover:bg-gray-50"><ChevronRight size={14} /></button>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          予定 {schedules.filter((s) => s.status !== "completed").length}件
          / 実績 {schedules.filter((s) => s.status === "completed").length}件
          / 合計 {schedules.length}件
        </div>
      </div>

      {/* 一括操作ツールバー */}
      <div className="flex items-center gap-2 px-4 py-1.5 border-b bg-gray-50 shrink-0">
        <span className="text-xs text-gray-500 mr-1">
          {selectedIds.size > 0 ? `${selectedIds.size}件選択中` : "一括操作"}
        </span>
        <button
          onClick={bulkToCompleted}
          disabled={bulkProcessing || selectedIds.size === 0}
          className="inline-flex items-center gap-1 rounded border border-orange-300 bg-orange-50 px-2.5 py-1 text-xs font-medium text-orange-700 hover:bg-orange-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Check size={12} />
          実績変換
        </button>
        <button
          onClick={bulkToScheduled}
          disabled={bulkProcessing || selectedIds.size === 0}
          className="inline-flex items-center gap-1 rounded border border-blue-300 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <RotateCcw size={12} />
          予定に戻す
        </button>
        <button
          onClick={bulkCopy}
          disabled={bulkProcessing || selectedIds.size === 0}
          className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Copy size={12} />
          複写
        </button>
        <button
          onClick={bulkDelete}
          disabled={bulkProcessing || selectedIds.size === 0}
          className="inline-flex items-center gap-1 rounded border border-red-300 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Trash2 size={12} />
          削除
        </button>
        {bulkProcessing && <Loader2 size={14} className="animate-spin text-blue-500 ml-1" />}
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center"><Loader2 size={24} className="animate-spin text-blue-500" /></div>
      ) : schedules.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-gray-400">この月の予定はありません</div>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs border-collapse">
            <thead className="bg-yellow-50 border-b sticky top-0 z-10">
              <tr>
                <th className="border border-gray-300 px-1 py-1.5 text-center font-bold w-8">
                  <input
                    type="checkbox"
                    checked={schedules.length > 0 && selectedIds.size === schedules.length}
                    onChange={toggleSelectAll}
                    className="h-3.5 w-3.5 accent-blue-600 cursor-pointer"
                    title="全選択/解除"
                  />
                </th>
                <th className="border border-gray-300 px-1 py-1.5 text-center font-bold w-16">予実</th>
                <th className="border border-gray-300 px-2 py-1.5 text-left font-bold text-red-700">利用日</th>
                <th className="border border-gray-300 px-2 py-1.5 text-left font-bold">利用時間</th>
                <th className="border border-gray-300 px-2 py-1.5 text-left font-bold text-red-700">*サービス内容</th>
                <th className="border border-gray-300 px-2 py-1.5 text-center font-bold">
                  {entityType === "user" ? "職員 1" : "利用者"}
                </th>
                <th className="border border-gray-300 px-2 py-1.5 text-center font-bold w-12">記録</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((sched) => {
                const isCopy = sched._isCopy === true;
                const hasDate = !!sched.visit_date;
                const day = hasDate ? parseInt(sched.visit_date.split("-")[2], 10) : 0;
                const dow = hasDate ? dowStr(sched.visit_date) : "";
                const isSat = dow === "土";
                const isSun = dow === "日";
                const isCompleted = sched.status === "completed";
                const isToggling = togglingId === sched.id;

                return (
                  <tr
                    key={sched.id}
                    className={cn(
                      "hover:bg-yellow-50/50 transition-colors",
                      isCopy ? "bg-green-50/40" : isSun ? "bg-red-50/20" : isSat ? "bg-blue-50/20" : ""
                    )}
                  >
                    {/* 選択チェックボックス */}
                    <td className="border border-gray-300 px-1 py-1 text-center">
                      {!isCopy ? (
                        <input
                          type="checkbox"
                          checked={selectedIds.has(sched.id)}
                          onChange={() => toggleSelect(sched.id)}
                          className="h-3.5 w-3.5 accent-blue-600 cursor-pointer"
                        />
                      ) : (
                        <button
                          onClick={() => removeCopyRow(sched.id)}
                          className="text-red-400 hover:text-red-600"
                          title="複写を取消"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </td>
                    {/* 予定/実績 トグルスイッチ */}
                    <td className="border border-gray-300 px-1 py-1 text-center">
                      {isCopy ? (
                        <span className="text-[10px] text-green-600 font-bold">複写</span>
                      ) : (
                        <button
                          onClick={() => toggleStatus(sched)}
                          disabled={isToggling}
                          className="inline-flex items-center gap-1 group"
                          title={isCompleted ? "実績 → 予定に戻す" : "予定 → 実績に変更"}
                        >
                          <span className={cn(
                            "relative inline-block w-8 h-4 rounded-full transition-colors",
                            isCompleted ? "bg-orange-500" : "bg-gray-300",
                            isToggling && "opacity-50"
                          )}>
                            <span className={cn(
                              "absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform",
                              isCompleted ? "translate-x-4" : "translate-x-0.5"
                            )} />
                          </span>
                          <span className={cn(
                            "text-[10px] font-bold min-w-[1.2rem]",
                            isCompleted ? "text-orange-700" : "text-blue-600"
                          )}>
                            {isCompleted ? "実" : "予"}
                          </span>
                        </button>
                      )}
                    </td>
                    {/* 利用日 + カレンダーアイコン */}
                    <td className="border border-gray-300 px-2 py-1 whitespace-nowrap">
                      {isCopy && !hasDate ? (
                        <div className="flex items-center gap-1">
                          <span className="text-gray-400 italic text-[10px]">日付未設定</span>
                          <label className="cursor-pointer text-blue-500 hover:text-blue-700" title="日付を選択">
                            <CalendarDays size={14} />
                            <input
                              type="date"
                              className="sr-only"
                              onChange={(e) => {
                                if (e.target.value) saveCopyDate(sched, e.target.value);
                              }}
                            />
                          </label>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1">
                          <span className="font-bold">{day}</span>
                          <span className={cn(
                            "ml-0.5",
                            isSun ? "text-red-500" : isSat ? "text-blue-500" : "text-gray-500"
                          )}>
                            ({dow})
                          </span>
                          {!isCopy && (
                            <label className="cursor-pointer text-gray-300 hover:text-blue-500 ml-auto" title="日付を変更">
                              <CalendarDays size={12} />
                              <input
                                type="date"
                                className="sr-only"
                                defaultValue={sched.visit_date}
                                onChange={async (e) => {
                                  if (!e.target.value || e.target.value === sched.visit_date) return;
                                  const { error } = await supabase.from("kaigo_visit_schedule")
                                    .update({ visit_date: e.target.value }).eq("id", sched.id);
                                  if (error) { toast.error("日付変更に失敗"); return; }
                                  setSchedules((prev) => prev.map((s) =>
                                    s.id === sched.id ? { ...s, visit_date: e.target.value } : s
                                  ));
                                  toast.success("日付を変更しました");
                                }}
                              />
                            </label>
                          )}
                        </div>
                      )}
                    </td>
                    {/* 利用時間 */}
                    <td
                      className="border border-gray-300 px-2 py-1 whitespace-nowrap cursor-pointer hover:bg-blue-50"
                      onClick={() => onEditSchedule?.(sched)}
                    >
                      <span className="font-mono">{sched.start_time?.slice(0, 5)}-{sched.end_time?.slice(0, 5)}</span>
                      <span className="ml-1 text-gray-400">{durationShort(sched.start_time, sched.end_time)}</span>
                    </td>
                    {/* サービス内容 */}
                    <td className="border border-gray-300 px-2 py-1">
                      <span className={cn(
                        "inline-block rounded px-1.5 py-0.5 text-[10px] font-medium",
                        SERVICE_TYPE_COLORS[sched.service_type] ?? "bg-gray-100 text-gray-700"
                      )}>
                        {sched.service_type}
                      </span>
                    </td>
                    {/* 職員/利用者 */}
                    <td className="border border-gray-300 px-2 py-1 text-center">
                      {entityType === "user"
                        ? sched.staff_name ?? "未割当"
                        : sched.user_name ?? "不明"}
                    </td>
                    {/* 記録 */}
                    <td className="border border-gray-300 px-1 py-1 text-center">
                      {isCompleted && (
                        <span className="inline-block w-3 h-3 rounded-sm bg-orange-200 border border-orange-400" title="実績記録あり" />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function ShiftManagementPage() {
  const supabase = createClient();
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("user");
  const [users, setUsers] = useState<KaigoUser[]>([]);
  const [staff, setStaff] = useState<KaigoStaff[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedStaffId, setSelectedStaffId] = useState<string | null>(null);
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [loadingLists, setLoadingLists] = useState(true);
  const [showPatternModal, setShowPatternModal] = useState(false);
  const [showUrlModal, setShowUrlModal] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("calendar");
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [hasPendingChanges, setHasPendingChanges] = useState(false);

  // ── Page-level edit modal (shared across all views) ──
  const [pageEditModal, setPageEditModal] = useState<VisitSchedule | null>(null);
  const [pageEditForm, setPageEditForm] = useState({ start_time: "", end_time: "", service_type: "", staff_id: "" });
  const [pageEditSaving, setPageEditSaving] = useState(false);

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

  useEffect(() => {
    const fetch = async () => {
      setLoadingLists(true);
      const [userRes, staffRes] = await Promise.all([
        supabase.from("clients").select("id, name, name_kana:furigana, status").eq("status", "active").eq("is_facility", false).order("furigana", { nullsFirst: false }),
        supabase.from("members").select("id, name, name_kana:furigana, status").eq("status", "active").order("furigana", { nullsFirst: false }),
      ]);
      const u = userRes.data || [];
      const s = staffRes.data || [];
      setUsers(u);
      setStaff(s);
      if (u.length > 0) setSelectedUserId(u[0].id);
      if (s.length > 0) setSelectedStaffId(s[0].id);
      setLoadingLists(false);
    };
    fetch();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedUser = users.find((u) => u.id === selectedUserId);
  const selectedStaffMember = staff.find((s) => s.id === selectedStaffId);

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b bg-white px-4 py-3 shrink-0">
        <div className="flex items-center gap-2">
          <CalendarDays className="text-blue-600" size={22} />
          <h1 className="text-lg font-bold text-gray-900">シフト管理</h1>
        </div>
        <div className="flex items-center gap-2">
          {/* View mode toggle - only show for staff tab */}
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
        {/* Sidebar */}
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
          loading={loadingLists}
        />

        {/* Calendar / Timeline area */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {viewMode === "timeline" && sidebarTab === "staff" ? (
            <TimelineView
              tab={sidebarTab}
              users={users}
              staff={staff}
              selectedDate={selectedDate}
              onDateChange={setSelectedDate}
              currentMonth={currentMonth}
              onMonthChange={setCurrentMonth}
              onPendingChangesChange={setHasPendingChanges}
              onEditSchedule={openPageEditModal}
            />
          ) : viewMode === "monthly-individual" ? (
            /* 月間個別ビュー（利用者タブのみ） */
            sidebarTab === "user" ? (
              selectedUserId && selectedUser ? (
                <MonthlyIndividualView
                  entityId={selectedUserId}
                  entityName={selectedUser.name}
                  entityType="user"
                  currentMonth={currentMonth}
                  onMonthChange={setCurrentMonth}
                  staff={staff}
                  onEditSchedule={openPageEditModal}
                />
              ) : (
                <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
                  利用者を選択してください
                </div>
              )
            ) : (
              // 職員タブで月間個別が選ばれた場合はカレンダーにフォールバック
              selectedStaffId && selectedStaffMember ? (
                <StaffCalendar
                  staffId={selectedStaffId}
                  staffName={selectedStaffMember.name}
                  currentMonth={currentMonth}
                  onMonthChange={setCurrentMonth}
                  onEditSchedule={openPageEditModal}
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
                userId={selectedUserId}
                userName={selectedUser.name}
                currentMonth={currentMonth}
                onMonthChange={setCurrentMonth}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
                利用者を選択してください
              </div>
            )
          ) : selectedStaffId && selectedStaffMember ? (
            <StaffCalendar
              staffId={selectedStaffId}
              staffName={selectedStaffMember.name}
              currentMonth={currentMonth}
              onMonthChange={setCurrentMonth}
              onEditSchedule={openPageEditModal}
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

      {/* Page-level edit modal */}
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
