"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Check,
  Loader2,
  Copy,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import {
  format,
  startOfMonth,
  endOfMonth,
  addMonths,
  subMonths,
  parseISO,
} from "date-fns";
import { ja } from "date-fns/locale";
import { cn } from "@/lib/utils";
import {
  SERVICE_TYPE_COLORS,
  type KaigoStaff,
  type VisitSchedule,
} from "./_shared";
import {
  useKaigoVisitSchedulesByUser,
  useKaigoVisitSchedulesByStaff,
} from "@/lib/swr/use-kaigo-visit-schedules";

export interface MonthlyIndividualInitialData {
  schedules: VisitSchedule[];
}

interface MonthlyIndividualViewProps {
  entityId: string;
  entityName: string;
  entityType: "user" | "staff";
  currentMonth: Date;
  onMonthChange: (d: Date) => void;
  staff: KaigoStaff[];
  onEditSchedule?: (sched: VisitSchedule) => void;
  initialData: MonthlyIndividualInitialData;
}

export function MonthlyIndividualView({
  entityId,
  entityName,
  entityType,
  currentMonth,
  onMonthChange,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
  staff,
  onEditSchedule,
  initialData,
}: MonthlyIndividualViewProps) {
  const supabase = useMemo(() => createClient(), []);
  // 楽観的 local state (複写行 _isCopy 等)。SWR data の到着で sync する。
  const [schedules, setSchedules] = useState<VisitSchedule[]>(initialData.schedules);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkProcessing, setBulkProcessing] = useState(false);

  const monthFrom = useMemo(() => format(startOfMonth(currentMonth), "yyyy-MM-dd"), [currentMonth]);
  const monthTo = useMemo(() => format(endOfMonth(currentMonth), "yyyy-MM-dd"), [currentMonth]);
  const hasInitial = initialData.schedules.length > 0;

  // entityType に応じて hook を使い分け。SWR の hook は条件的に呼べないので両方呼び、
  // 使う方の data だけ採用する (key が null だと fetch は走らない)。
  const userResult = useKaigoVisitSchedulesByUser(
    entityType === "user" ? entityId : null,
    monthFrom,
    monthTo,
    entityType === "user" && hasInitial ? initialData.schedules : undefined,
  );
  const staffResult = useKaigoVisitSchedulesByStaff(
    entityType === "staff" ? entityId : null,
    monthFrom,
    monthTo,
    entityType === "staff" && hasInitial ? initialData.schedules : undefined,
  );
  const active = entityType === "user" ? userResult : staffResult;
  const swrSchedules = useMemo(() => {
    // by-user は visit_date 順序保証なし (start_time のみ order)、表示時は元来 visit_date,start_time 二段ソート。
    return [...active.schedules].sort((a, b) => {
      if (a.visit_date !== b.visit_date) return a.visit_date.localeCompare(b.visit_date);
      return (a.start_time ?? "").localeCompare(b.start_time ?? "");
    });
  }, [active.schedules]);
  const loading = active.isLoading;

  // SWR data → local state へ sync
  const lastSwrRef = useRef(swrSchedules);
  useEffect(() => {
    if (swrSchedules !== lastSwrRef.current) {
      lastSwrRef.current = swrSchedules;
      setSchedules(swrSchedules);
    }
  }, [swrSchedules]);

  const toggleStatus = async (sched: VisitSchedule) => {
    const isCurrentlyCompleted = sched.status === "completed";
    setTogglingId(sched.id);

    if (!isCurrentlyCompleted) {
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
      await supabase.from("kaigo_visit_schedule").update({ status: "completed" }).eq("id", sched.id);
      setSchedules((prev) => prev.map((s) => s.id === sched.id ? { ...s, status: "completed" } : s));
      toast.success("実績に変更しました（提供表にも反映）");
    } else {
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

  const bulkCopy = () => {
    if (selectedIds.size === 0) { toast.error("対象を選択してください"); return; }
    const targets = schedules.filter((s) => selectedIds.has(s.id) && s.status !== "completed");
    if (targets.length === 0) { toast.error("予定のみ複写できます（実績は不可）"); return; }
    const newSchedules: VisitSchedule[] = [];
    for (const sched of schedules) {
      newSchedules.push(sched);
      if (targets.some((t) => t.id === sched.id)) {
        const copyId = `copy-${sched.id}-${Date.now()}`;
        newSchedules.push({
          ...sched,
          id: copyId,
          visit_date: "",
          status: "scheduled",
          _isCopy: true,
        });
      }
    }
    setSchedules(newSchedules);
    setSelectedIds(new Set());
    toast.success(`${targets.length}件を複写しました（日付を設定してください）`);
  };

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
    setSchedules((prev) => prev.map((s) =>
      s.id === copyRow.id ? { ...s, id: data.id, visit_date: dateStr, _isCopy: false } : s
    ));
    toast.success("予定を保存しました");
  };

  const removeCopyRow = (copyId: string) => {
    setSchedules((prev) => prev.filter((s) => s.id !== copyId));
  };

  const bulkDelete = async () => {
    if (selectedIds.size === 0) { toast.error("対象を選択してください"); return; }
    const ok = window.confirm(`選択された${selectedIds.size}件を削除します。\n予定も実績も削除されますが、本当によろしいですか？`);
    if (!ok) return;
    setBulkProcessing(true);
    const targets = schedules.filter((s) => selectedIds.has(s.id));
    for (const sched of targets) {
      await supabase.from("kaigo_visit_records").delete()
        .eq("user_id", sched.user_id).eq("visit_date", sched.visit_date).eq("start_time", sched.start_time);
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
                    <td
                      className="border border-gray-300 px-2 py-1 whitespace-nowrap cursor-pointer hover:bg-blue-50"
                      onClick={() => onEditSchedule?.(sched)}
                    >
                      <span className="font-mono">{sched.start_time?.slice(0, 5)}-{sched.end_time?.slice(0, 5)}</span>
                      <span className="ml-1 text-gray-400">{durationShort(sched.start_time, sched.end_time)}</span>
                    </td>
                    <td className="border border-gray-300 px-2 py-1">
                      <span className={cn(
                        "inline-block rounded px-1.5 py-0.5 text-[10px] font-medium",
                        SERVICE_TYPE_COLORS[sched.service_type] ?? "bg-gray-100 text-gray-700"
                      )}>
                        {sched.service_type}
                      </span>
                    </td>
                    <td className="border border-gray-300 px-2 py-1 text-center">
                      {entityType === "user"
                        ? sched.staff_name ?? "未割当"
                        : sched.user_name ?? "不明"}
                    </td>
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
