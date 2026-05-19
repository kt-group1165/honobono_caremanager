"use client";

import { useState, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  X,
  Loader2,
  AlertTriangle,
  Save,
  Plus,
} from "lucide-react";
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  getDay,
  addMonths,
  subMonths,
  isSameDay,
} from "date-fns";
import { ja } from "date-fns/locale";
import { cn } from "@/lib/utils";
import { ServiceSelector } from "@/components/services/service-selector";
import {
  DOW_LABELS,
  isStaffUnavailableAtTime,
  type KaigoStaff,
  type StaffAvailabilitySlot,
  type VisitSchedule,
} from "./_shared";
import {
  useKaigoVisitSchedulesByUser,
  useKaigoVisitSchedulesByMonthAll,
} from "@/lib/swr/use-kaigo-visit-schedules";
import { useKaigoAvailability } from "@/lib/swr/use-kaigo-availability";
import { useKaigoOfficeStaff } from "@/lib/swr/use-kaigo-office-staff";
import { useKaigoServiceProviders } from "@/lib/swr/use-kaigo-service-providers";

export interface UserCalendarInitialData {
  schedules: VisitSchedule[];
  availability: StaffAvailabilitySlot[];
  allStaff: KaigoStaff[];
  allProviders: { id: string; provider_name: string }[];
  allSchedules: VisitSchedule[];
}

interface UserCalendarProps {
  userId: string;
  userName: string;
  currentMonth: Date;
  onMonthChange: (d: Date) => void;
  initialData: UserCalendarInitialData;
}

export function UserCalendar({
  userId,
  userName,
  currentMonth,
  onMonthChange,
  initialData,
}: UserCalendarProps) {
  const supabase = useMemo(() => createClient(), []);
  const { currentOfficeId } = useBusinessType();

  const monthFrom = useMemo(() => format(startOfMonth(currentMonth), "yyyy-MM-dd"), [currentMonth]);
  const monthTo = useMemo(() => format(endOfMonth(currentMonth), "yyyy-MM-dd"), [currentMonth]);

  // SWR fallbackData: initial mount でのみ意味あり (key 変更で消える)
  const hasInitial = initialData.schedules.length > 0 || initialData.availability.length > 0
    || initialData.allStaff.length > 0 || initialData.allSchedules.length > 0
    || initialData.allProviders.length > 0;

  const { schedules, isLoading: schedLoading, mutate: mutateSched } = useKaigoVisitSchedulesByUser(
    userId,
    monthFrom,
    monthTo,
    hasInitial ? initialData.schedules : undefined,
  );
  const { availability, isLoading: availLoading } = useKaigoAvailability(
    null, // all-staff (旧 fetch も staffId フィルタ無し)
    monthFrom,
    monthTo,
    hasInitial ? initialData.availability : undefined,
  );
  const { staff: allStaff, isLoading: allStaffLoading } = useKaigoOfficeStaff(
    currentOfficeId,
    hasInitial ? initialData.allStaff : undefined,
  );
  const { schedules: allSchedules, mutate: mutateAllSched } = useKaigoVisitSchedulesByMonthAll(
    monthFrom,
    monthTo,
    hasInitial ? initialData.allSchedules : undefined,
  );
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- provider data は将来 service-selector が利用予定
  const { providers: allProviders } = useKaigoServiceProviders(
    hasInitial ? initialData.allProviders : undefined,
  );

  const loading = schedLoading || availLoading || allStaffLoading;

  // mutation 後に schedules / allSchedules を一括で再 fetch
  const refetchAfterMutation = () => {
    mutateSched();
    mutateAllSched();
  };

  const [editModal, setEditModal] = useState<VisitSchedule | null>(null);
  const [editForm, setEditForm] = useState({ start_time: "", end_time: "", service_type: "", staff_id: "", service_code: "", service_name: "" });
  const [editSaving, setEditSaving] = useState(false);
  const [editDeleting, setEditDeleting] = useState(false);
  const [showServiceSelector, setShowServiceSelector] = useState(false);
  const [addModal, setAddModal] = useState<string | null>(null);
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
      refetchAfterMutation();
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
      refetchAfterMutation();
    }
    setEditDeleting(false);
  };

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
      refetchAfterMutation();
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
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">日付</label>
                <p className="text-sm font-semibold text-gray-900">
                  {format(new Date(editModal.visit_date + "T00:00:00"), "yyyy年M月d日(E)", { locale: ja })}
                </p>
              </div>

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
                  startTime={editForm.start_time}
                  endTime={editForm.end_time}
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
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">日付</label>
                <p className="text-sm font-semibold text-gray-900">
                  {format(new Date(addModal + "T00:00:00"), "yyyy年M月d日(E)", { locale: ja })}
                </p>
              </div>

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
                  startTime={addForm.start_time}
                  endTime={addForm.end_time}
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
