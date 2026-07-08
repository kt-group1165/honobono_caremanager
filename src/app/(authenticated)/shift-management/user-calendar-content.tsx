"use client";

import { useState, useMemo, useEffect } from "react";
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
  parseISO,
} from "date-fns";
import { ja } from "date-fns/locale";
import { cn } from "@/lib/utils";
import { ServiceSelector } from "@/components/services/service-selector";
import { StaffCombobox } from "@/components/shared/staff-combobox";
import { serviceShortName } from "@/lib/service-short-name";
import { getServiceSystemMap } from "@/lib/service-system-lookup";
import { toHankakuDigits } from "@/lib/service-name-normalize";
import {
  buildAdditionalStaffPayload,
  DOW_LABELS,
  insertVisitSchedules,
  isStaffUnavailableAtTime,
  staffTimeRelationWarning,
  supportsAdditionalStaff,
  supportsKinkyuHoumon,
  supportsStaff2Times,
  twoPersonMismatchWarning,
  type KaigoStaff,
  type StaffAvailabilitySlot,
  type VisitSchedule,
} from "./_shared";
import {
  AdditionalStaffSection,
  additionalRowsFromSchedule,
  type AdditionalStaffRow,
} from "./additional-staff-section";
import {
  getHospitalizationMap,
  isHospitalizedOn,
  type HospitalizationPeriod,
} from "@/lib/hospitalization";
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

  // C3: kinkyu_houmon 列が DB に適用済みか (未適用ならチェックボックス非表示)
  const [kinkyuSupported, setKinkyuSupported] = useState(false);
  // 2人体制の個別時間列 (staff2_start_time 等) が適用済みか
  const [staff2TimesSupported, setStaff2TimesSupported] = useState(false);
  // additional_staff (jsonb, 追加職員 最大9名) 列が適用済みか
  const [additionalStaffSupported, setAdditionalStaffSupported] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void supportsKinkyuHoumon(supabase).then((ok) => {
      if (!cancelled) setKinkyuSupported(ok);
    });
    void supportsStaff2Times(supabase).then((ok) => {
      if (!cancelled) setStaff2TimesSupported(ok);
    });
    void supportsAdditionalStaff(supabase).then((ok) => {
      if (!cancelled) setAdditionalStaffSupported(ok);
    });
    return () => { cancelled = true; };
  }, [supabase]);

  // 入院期間 (🏥 バッジ用)。利用者切替で 1 回 fetch (期間は全履歴を取得済み)。
  const [hospPeriods, setHospPeriods] = useState<HospitalizationPeriod[]>([]);
  useEffect(() => {
    let cancelled = false;
    getHospitalizationMap(supabase, [userId])
      .then((m) => {
        if (!cancelled) setHospPeriods(m.get(userId) ?? []);
      })
      .catch((e) => {
        // バッジは補助情報: 取得失敗は log のみ (画面は継続)
        console.error("hospitalization fetch failed:", e);
      });
    return () => { cancelled = true; };
  }, [supabase, userId]);

  const [editModal, setEditModal] = useState<VisitSchedule | null>(null);
  const [editForm, setEditForm] = useState({ start_time: "", end_time: "", service_type: "", staff_id: "", service_code: "", service_name: "", kinkyu_houmon: false });
  // 追加職員 (index0=職員2, index1=職員3, …)。最大9名
  const [editAdditional, setEditAdditional] = useState<AdditionalStaffRow[]>([]);
  const [editSaving, setEditSaving] = useState(false);
  const [editDeleting, setEditDeleting] = useState(false);
  const [showServiceSelector, setShowServiceSelector] = useState(false);
  // 選択したサービスの制度区分 (表示用バッジ。選択時に自動設定、手動変更しない)
  const [editServiceSystem, setEditServiceSystem] = useState<string | null>(null);
  const [addServiceSystem, setAddServiceSystem] = useState<string | null>(null);
  const [addModal, setAddModal] = useState<string | null>(null);
  const [addForm, setAddForm] = useState({ start_time: "09:00", end_time: "10:00", service_type: "", staff_id: "", service_code: "", service_name: "", kinkyu_houmon: false });
  const [addAdditional, setAddAdditional] = useState<AdditionalStaffRow[]>([]);
  const [addSaving, setAddSaving] = useState(false);
  const [showAddServiceSelector, setShowAddServiceSelector] = useState(false);
  // drag & drop: ドロップ先セルのハイライト用
  const [dragOverDate, setDragOverDate] = useState<string | null>(null);

  // ドラッグ = 移動 / Ctrl (Alt) + ドラッグ = コピー
  const handleDropSchedule = async (schedId: string, targetDate: string, copy: boolean) => {
    const sched = schedules.find((s) => s.id === schedId);
    if (!sched) return;
    if (!copy && sched.visit_date === targetDate) return;
    if (copy) {
      const { error } = await insertVisitSchedules(supabase, [{
        user_id: sched.user_id,
        staff_id: sched.staff_id,
        staff_id_2: sched.staff_id_2 ?? null,
        staff_id_3: sched.staff_id_3 ?? null,
        // 追加職員 (3人目以降) も複写。列未適用は insertVisitSchedules が strip
        ...(sched.additional_staff !== undefined ? { additional_staff: sched.additional_staff ?? null } : {}),
        visit_date: targetDate,
        start_time: sched.start_time,
        end_time: sched.end_time,
        service_type: sched.service_type,
        status: "scheduled",
        // C5: 発生元 office (列未適用は helper が strip)
        ...(currentOfficeId ? { office_id: currentOfficeId } : {}),
      }]);
      if (error) {
        toast.error("コピーに失敗しました: " + error.message);
        return;
      }
      toast.success(`${format(parseISO(targetDate), "M/d")} に予定をコピーしました`);
    } else {
      // 実績は提供表/請求と紐づくため移動不可 (コピーは可)
      if (sched.status === "completed") {
        toast.error("実績は移動できません (Ctrl+ドラッグでコピーは可能)");
        return;
      }
      const { error } = await supabase
        .from("kaigo_visit_schedule")
        .update({ visit_date: targetDate })
        .eq("id", sched.id);
      if (error) {
        toast.error("移動に失敗しました: " + error.message);
        return;
      }
      toast.success(`${format(parseISO(targetDate), "M/d")} に予定を移動しました`);
    }
    refetchAfterMutation();
  };

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
    // 既存サービスの制度区分をマスタから引いてバッジ表示 (async)
    // 有効期間: 予定の対象月に有効な世代で引く (改定跨ぎ対策)
    setEditServiceSystem(null);
    void getServiceSystemMap(supabase, [sched.service_type], {
      year: Number(sched.visit_date.slice(0, 4)),
      month: Number(sched.visit_date.slice(5, 7)),
    }).then((m) => {
      setEditServiceSystem(m.get(toHankakuDigits(sched.service_type)) ?? null);
    });
    setEditForm({
      start_time: sched.start_time?.slice(0, 5) ?? "09:00",
      end_time: sched.end_time?.slice(0, 5) ?? "10:00",
      service_type: sched.service_type,
      staff_id: sched.staff_id ?? "",
      service_code: "",
      service_name: sched.service_type,
      kinkyu_houmon: sched.kinkyu_houmon ?? false,
    });
    setEditAdditional(additionalRowsFromSchedule(sched));
    // SWR の select には kinkyu_houmon / staff2_*_time / additional_staff を含めない
    // (列未適用環境で 42703 になるため)。対応 DB では現在値を単発で引いて反映する。
    // additional_staff (3人目以降含む) は select に無いので対応 DB では必ず引き直す。
    const extraCols = [
      ...(kinkyuSupported && sched.kinkyu_houmon === undefined ? ["kinkyu_houmon"] : []),
      ...(staff2TimesSupported ? ["staff2_start_time", "staff2_end_time", "staff3_start_time", "staff3_end_time"] : []),
      ...(additionalStaffSupported ? ["additional_staff", "staff_id_2", "staff_id_3"] : []),
    ];
    if (extraCols.length > 0) {
      void supabase
        .from("kaigo_visit_schedule")
        .select([...new Set(extraCols)].join(", "))
        .eq("id", sched.id)
        .maybeSingle()
        .then(({ data, error }: { data: unknown; error: { message: string } | null }) => {
          if (error || !data) return;
          const row = data as {
            kinkyu_houmon?: boolean | null;
            staff_id_2?: string | null;
            staff_id_3?: string | null;
            staff2_start_time?: string | null;
            staff2_end_time?: string | null;
            staff3_start_time?: string | null;
            staff3_end_time?: string | null;
            additional_staff?: Array<{ staff_id: string; start_time: string | null; end_time: string | null }> | null;
          };
          if (row.kinkyu_houmon !== undefined) {
            setEditForm((f) => ({ ...f, kinkyu_houmon: !!row.kinkyu_houmon }));
          }
          // 追加職員を最新値で復元 (additional_staff 優先、無ければ従来列)
          setEditAdditional(additionalRowsFromSchedule(row));
        });
    }
  };

  const handleEditSave = async () => {
    if (!editModal) return;
    // 実績 (完了済) は提供表・請求集計に反映されるため、変更前に確認する
    if (
      editModal.status === "completed" &&
      !window.confirm("この予定は既に実績になっています。変更すると提供表・請求集計にも反映されます。変更しますか？")
    ) {
      return;
    }
    setEditSaving(true);
    const updateData: Record<string, unknown> = {
      start_time: editForm.start_time + ":00",
      end_time: editForm.end_time + ":00",
      service_type: editForm.service_name || editForm.service_type,
      staff_id: editForm.staff_id || null,
    };
    // C3: 緊急時訪問介護加算フラグ (列未適用環境では含めない)
    if (kinkyuSupported) updateData.kinkyu_houmon = editForm.kinkyu_houmon;
    // 追加職員: additional_staff (jsonb) + 従来列 staff_id_2/3 + staff2/3_*_time にミラー。
    // 列未適用環境では additional_staff / staff2/3_*_time を strip (staff_id_2/3 は基本列)。
    const addlPayload = buildAdditionalStaffPayload(editAdditional);
    for (const [k, v] of Object.entries(addlPayload)) {
      if (k === "additional_staff" && !additionalStaffSupported) continue;
      if ((k === "staff2_start_time" || k === "staff2_end_time" || k === "staff3_start_time" || k === "staff3_end_time") && !staff2TimesSupported) continue;
      updateData[k] = v;
    }
    const { error } = await supabase
      .from("kaigo_visit_schedule")
      .update(updateData)
      .eq("id", editModal.id);
    if (error) {
      toast.error("更新に失敗しました: " + error.message);
    } else {
      toast.success("予定を更新しました");
      const first = editAdditional.find((r) => r.staff_id);
      const warn = twoPersonMismatchWarning(
        editForm.service_name || editForm.service_type,
        first?.staff_id || null,
      );
      if (warn) toast.warning(warn);
      // 職員2 (先頭の追加職員) 個別時間の関係警告 (障害は制度上別算定なので出さない)
      if (first && first.custom && first.start && first.end) {
        const timeWarn = staffTimeRelationWarning(
          editForm.start_time, editForm.end_time,
          first.start, first.end,
          editForm.service_name || editForm.service_type,
          editServiceSystem === "障害",
        );
        if (timeWarn) toast.warning(timeWarn);
      }
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
    setAddServiceSystem(null);
    setAddForm({ start_time: "09:00", end_time: "10:00", service_type: "", staff_id: "", service_code: "", service_name: "", kinkyu_houmon: false });
    setAddAdditional([]);
  };

  const handleAddSave = async () => {
    if (!addModal) return;
    if (!addForm.service_name) {
      toast.error("サービスを選択してください");
      return;
    }
    setAddSaving(true);
    // 追加職員: additional_staff (jsonb) + 従来列ミラー。列未適用は insertVisitSchedules が strip
    const addlPayload = buildAdditionalStaffPayload(addAdditional);
    const { error } = await insertVisitSchedules(supabase, [{
      user_id: userId,
      visit_date: addModal,
      start_time: addForm.start_time + ":00",
      end_time: addForm.end_time + ":00",
      service_type: addForm.service_name || addForm.service_type,
      staff_id: addForm.staff_id || null,
      // C3/C5: 列未適用 (42703/PGRST204) は insertVisitSchedules が strip して retry
      ...(kinkyuSupported ? { kinkyu_houmon: addForm.kinkyu_houmon } : {}),
      ...addlPayload,
      ...(currentOfficeId ? { office_id: currentOfficeId } : {}),
    }]);
    if (error) {
      toast.error("追加に失敗しました: " + error.message);
    } else {
      toast.success("予定を追加しました");
      const first = addAdditional.find((r) => r.staff_id);
      const warn = twoPersonMismatchWarning(
        addForm.service_name || addForm.service_type,
        first?.staff_id || null,
      );
      if (warn) toast.warning(warn);
      // 職員2 (先頭の追加職員) 個別時間の関係警告 (障害は制度上別算定なので出さない)
      if (first && first.custom && first.start && first.end) {
        const timeWarn = staffTimeRelationWarning(
          addForm.start_time, addForm.end_time,
          first.start, first.end,
          addForm.service_name || addForm.service_type,
          addServiceSystem === "障害",
        );
        if (timeWarn) toast.warning(timeWarn);
      }
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
              const hosp = isHospitalizedOn(hospPeriods, dateStr);

              return (
                <div
                  key={dateStr}
                  className={cn(
                    "rounded border min-h-[80px] p-1 text-left",
                    dow === 0 ? "bg-red-50/40" : dow === 6 ? "bg-blue-50/40" : "bg-white",
                    dragOverDate === dateStr && "ring-2 ring-blue-400 bg-blue-50/60"
                  )}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = e.ctrlKey || e.altKey ? "copy" : "move";
                    if (dragOverDate !== dateStr) setDragOverDate(dateStr);
                  }}
                  onDragLeave={() => {
                    if (dragOverDate === dateStr) setDragOverDate(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOverDate(null);
                    const id = e.dataTransfer.getData("text/plain");
                    if (id) void handleDropSchedule(id, dateStr, e.ctrlKey || e.altKey);
                  }}
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
                    {hosp && (
                      <span
                        className="rounded bg-rose-100 px-1 py-0.5 text-[8px] font-bold text-rose-700 leading-none"
                        title={`入院中${hosp.hospital_name ? ` (${hosp.hospital_name})` : ""}: ${hosp.admission_date}〜${hosp.discharge_date ?? "退院日未定"}`}
                      >
                        🏥入院中
                      </span>
                    )}
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
                      const extraStaff = [sched.staff_id_2, sched.staff_id_3].filter(Boolean).length;
                      return (
                        <button
                          key={sched.id}
                          onClick={() => openEditModal(sched)}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData("text/plain", sched.id);
                            e.dataTransfer.effectAllowed = "copyMove";
                          }}
                          onDragEnd={() => setDragOverDate(null)}
                          className={cn(
                            "w-full text-left rounded px-1 py-0.5 text-[8px] leading-tight whitespace-nowrap overflow-hidden text-ellipsis cursor-pointer transition-colors",
                            unavail
                              ? "bg-yellow-50 text-yellow-700 font-semibold hover:bg-yellow-100"
                              : isCompleted
                              ? "bg-red-50 text-red-600 font-semibold hover:bg-red-100"
                              : "bg-blue-50 text-blue-700 hover:bg-blue-100"
                          )}
                          title={(isCompleted ? "実績（クリックして編集）" : "予定（クリックして編集）") + " / ドラッグで移動・Ctrl+ドラッグでコピー"}
                        >
                          {sched.start_time?.slice(0, 5)}~{sched.end_time?.slice(0, 5)} {sched.staff_name ?? ""}
                          {extraStaff > 0 && (
                            <span className="ml-0.5 rounded bg-indigo-100 px-0.5 font-bold text-indigo-700" title={`2人体制 (+${extraStaff}名)`}>
                              +{extraStaff}
                            </span>
                          )}
                          {" "}{serviceShortName(sched.service_type)}
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
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-gray-900">予定を編集</h2>
                {editModal.status === "completed" ? (
                  <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-bold text-orange-700">実績</span>
                ) : (
                  <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-bold text-blue-700">予定</span>
                )}
              </div>
              <button onClick={() => setEditModal(null)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              {editModal.status === "completed" && (
                <div className="flex items-start gap-2 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-800">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  この予定は既に実績になっています。変更すると提供表・請求集計にも反映されます。
                </div>
              )}
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
                <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500">
                  サービス
                  <ServiceSystemBadge system={editServiceSystem} />
                </label>
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
                    setEditServiceSystem(service.system);
                    setShowServiceSelector(false);
                  }}
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">担当職員</label>
                <StaffCombobox
                  value={editForm.staff_id}
                  onChange={(id) => setEditForm((f) => ({ ...f, staff_id: id }))}
                  options={allStaff.map((s) => {
                    const status = getStaffStatusForEdit(s.id);
                    return {
                      id: s.id,
                      name: s.name,
                      furigana: (s as unknown as { furigana?: string | null }).furigana ?? null,
                      suffix: status.unavail
                        ? " (対応不可)"
                        : status.conflict
                          ? " (重複)"
                          : undefined,
                    };
                  })}
                />
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

              {/* 追加職員 (2人体制・同行、主 + 最大9名): 普段は折りたたみ */}
              <AdditionalStaffSection
                rows={editAdditional}
                onChange={setEditAdditional}
                staffOptions={allStaff.map((s) => {
                  const status = getStaffStatusForEdit(s.id);
                  return {
                    id: s.id,
                    name: s.name,
                    furigana: (s as unknown as { furigana?: string | null }).furigana ?? null,
                    suffix: status.unavail
                      ? " (対応不可)"
                      : status.conflict
                        ? " (重複)"
                        : undefined,
                  };
                })}
                mainStaffId={editForm.staff_id}
                mainStart={editForm.start_time}
                mainEnd={editForm.end_time}
                serviceName={editForm.service_name || editForm.service_type}
                isShogai={editServiceSystem === "障害"}
                showCustomTime={staff2TimesSupported}
              />

              {/* C3: 緊急時訪問介護加算 (列未適用の DB では非表示) */}
              {kinkyuSupported && (
                <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                  <input
                    type="checkbox"
                    checked={editForm.kinkyu_houmon}
                    onChange={(e) => setEditForm((f) => ({ ...f, kinkyu_houmon: e.target.checked }))}
                    className="h-4 w-4 accent-red-600"
                  />
                  <span>緊急時訪問 (緊急時訪問介護加算)</span>
                </label>
              )}
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
                <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500">
                  サービス
                  <ServiceSystemBadge system={addServiceSystem} />
                </label>
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
                    setAddServiceSystem(service.system);
                    setShowAddServiceSelector(false);
                  }}
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">担当職員</label>
                <StaffCombobox
                  value={addForm.staff_id}
                  onChange={(id) => setAddForm((f) => ({ ...f, staff_id: id }))}
                  options={allStaff.map((s) => {
                    const status = getStaffStatusForAdd(s.id);
                    return {
                      id: s.id,
                      name: s.name,
                      furigana: (s as unknown as { furigana?: string | null }).furigana ?? null,
                      suffix: status.unavail
                        ? " (対応不可)"
                        : status.conflict
                          ? " (重複)"
                          : undefined,
                    };
                  })}
                />
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

              {/* 追加職員 (2人体制・同行、主 + 最大9名): 普段は折りたたみ */}
              <AdditionalStaffSection
                rows={addAdditional}
                onChange={setAddAdditional}
                staffOptions={allStaff.map((s) => {
                  const status = getStaffStatusForAdd(s.id);
                  return {
                    id: s.id,
                    name: s.name,
                    furigana: (s as unknown as { furigana?: string | null }).furigana ?? null,
                    suffix: status.unavail
                      ? " (対応不可)"
                      : status.conflict
                        ? " (重複)"
                        : undefined,
                  };
                })}
                mainStaffId={addForm.staff_id}
                mainStart={addForm.start_time}
                mainEnd={addForm.end_time}
                serviceName={addForm.service_name || addForm.service_type}
                isShogai={addServiceSystem === "障害"}
                showCustomTime={staff2TimesSupported}
              />

              {/* C3: 緊急時訪問介護加算 (列未適用の DB では非表示) */}
              {kinkyuSupported && (
                <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                  <input
                    type="checkbox"
                    checked={addForm.kinkyu_houmon}
                    onChange={(e) => setAddForm((f) => ({ ...f, kinkyu_houmon: e.target.checked }))}
                    className="h-4 w-4 accent-red-600"
                  />
                  <span>緊急時訪問 (緊急時訪問介護加算)</span>
                </label>
              )}
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

// ─── サービス種別バッジ (選択したサービスの制度区分を自動表示) ────────────────
function ServiceSystemBadge({ system }: { system: string | null }) {
  if (!system) return null;
  const label = system === "総合事業" ? "総合" : system === "独自" ? "独自" : system;
  const cls =
    system === "介護"
      ? "bg-blue-100 text-blue-700"
      : system === "総合事業"
      ? "bg-emerald-100 text-emerald-700"
      : system === "障害"
      ? "bg-purple-100 text-purple-700"
      : "bg-amber-100 text-amber-700";
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", cls)}>
      {label}
    </span>
  );
}
