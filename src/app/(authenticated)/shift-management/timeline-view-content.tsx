"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Loader2,
  Save,
  Undo2,
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
import {
  DOW_LABELS,
  isStaffUnavailableAtTime,
  timeToMinutes,
  type KaigoStaff,
  type KaigoUser,
  type SidebarTab,
  type StaffAvailabilitySlot,
  type VisitSchedule,
} from "./_shared";

interface PendingChange {
  type: "update" | "copy";
  schedId: string;
  updates: Record<string, string>;
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

export interface TimelineInitialData {
  schedules: VisitSchedule[];
  availability: StaffAvailabilitySlot[];
}

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
  initialData: TimelineInitialData;
}

export function TimelineView({
  tab,
  users,
  staff,
  selectedDate,
  onDateChange,
  currentMonth,
  onMonthChange,
  onPendingChangesChange,
  onEditSchedule,
  initialData,
}: TimelineViewProps) {
  const supabase = useMemo(() => createClient(), []);
  const [schedules, setSchedules] = useState<VisitSchedule[]>(initialData.schedules);
  const [availability, setAvailability] = useState<StaffAvailabilitySlot[]>(initialData.availability);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const timelineScrollRef = useRef<HTMLDivElement>(null);

  const [pendingChanges, setPendingChanges] = useState<PendingChange[]>([]);

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
    rowStartY: number;
  } | null>(null);
  const [dragPreview, setDragPreview] = useState<{
    rowIndex: number;
    left: number;
    width: number;
  } | null>(null);
  const draggingRef = useRef(dragging);
  // render 時に ref へ最新 state を mirror する pattern。drag handler 内で stale
  // closure を避けるための定石だが React Compiler refs rule は警告するため抑止。
  // eslint-disable-next-line react-hooks/refs
  draggingRef.current = dragging;

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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional dep stability
  }, [dateStr, supabase]);

  // initial render は server からの initialData を使用、filter 変更時のみ refetch。
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (timelineScrollRef.current && !loading) {
      const scrollPct = TIMELINE_DEFAULT_SCROLL_HOUR / 24;
      timelineScrollRef.current.scrollLeft = timelineScrollRef.current.scrollWidth * scrollPct;
    }
  }, [loading]);

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

  const getUnavailableRanges = (staffId: string) => {
    const staffAllSlots = availability.filter((a) => a.staff_id === staffId);
    if (staffAllSlots.length === 0) return [];
    const daySlots = staffAllSlots.filter((a) => a.available_date === dateStr);
    if (daySlots.length === 0) {
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

      const containerWidth = drag.barContainerRect.width;
      const deltaPercent = (deltaX / containerWidth) * 100;

      const origStyle = getBarStyle(drag.origStartTime, drag.origEndTime);
      const origLeft = parseFloat(origStyle.left);
      const origWidth = parseFloat(origStyle.width);

      const snapPercent = (15 / TIMELINE_TOTAL_MINUTES) * 100;
      let newLeft = origLeft + deltaPercent;
      newLeft = Math.round(newLeft / snapPercent) * snapPercent;
      newLeft = Math.max(0, Math.min(100 - origWidth, newLeft));

      const mouseY = e.clientY;
      let rowIndex = Math.floor((mouseY - drag.rowStartY) / drag.rowHeight);
      rowIndex = Math.max(0, Math.min(rows.length - 1, rowIndex));

      setDragPreview({ rowIndex, left: newLeft, width: origWidth });
    },
    [rows.length]
  );

  const handleTimelineMouseUp = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
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

      const newStartMinutes =
        (preview.left / 100) * TIMELINE_TOTAL_MINUTES + TIMELINE_START_HOUR * 60;
      const durationMinutes =
        (preview.width / 100) * TIMELINE_TOTAL_MINUTES;
      const newEndMinutes = newStartMinutes + durationMinutes;

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

      const rowField = tab === "user" ? "user_id" : "staff_id";

      const origStartStr = drag.origStartTime;
      const origEndStr = drag.origEndTime;
      const timeChanged =
        newStartTime !== origStartStr || newEndTime !== origEndStr;
      const rowChanged = newRowId !== drag.origRowId;

      if (!timeChanged && !rowChanged) return;

      const updateData: Record<string, string> = {};
      if (timeChanged) {
        updateData.start_time = newStartTime;
        updateData.end_time = newEndTime;
      }
      if (rowChanged) {
        updateData[rowField] = newRowId;
      }

      const origSchedule = schedules.find((s) => s.id === drag.schedId);
      if (!origSchedule) return;

      setDragDropChoice({
        schedId: drag.schedId,
        origSchedule,
        updateData,
        newRowId,
        newStartTime,
        newEndTime,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional dep stability
    [dragPreview, rows, tab, supabase, fetchData]
  );

  const handleDragChoiceMove = useCallback(() => {
    if (!dragDropChoice) return;
    const { schedId, updateData } = dragDropChoice;

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

    const copyData: Record<string, string | null> = {
      user_id: origSchedule.user_id,
      staff_id: origSchedule.staff_id,
      visit_date: origSchedule.visit_date,
      start_time: newStartTime,
      end_time: newEndTime,
      service_type: origSchedule.service_type,
    };
    copyData[rowField] = newRowId;

    const tempId = "temp-" + Math.random().toString(36).slice(2);

    setPendingChanges((prev) => [
      ...prev,
      { type: "copy", schedId: tempId, updates: {}, copyData },
    ]);

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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && draggingRef.current) {
        setDragging(null);
        setDragPreview(null);
      }
    };
    const handleMouseUp = () => {
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
          <div
            style={{ minWidth: "1800px", cursor: dragging ? "grabbing" : undefined }}
            onMouseMove={dragging ? handleTimelineMouseMove : undefined}
            onMouseUp={dragging ? handleTimelineMouseUp : undefined}
          >
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

            <div data-timeline-rows>
            {rows.map((row, rowIdx) => (
              <div key={row.id} className="flex border-b hover:bg-gray-50/50" data-row-id={row.id}>
                <div className="w-28 shrink-0 border-r sticky left-0 z-20 bg-white px-2 py-2 text-xs font-medium text-gray-800 truncate flex items-center">
                  {row.name}
                </div>
                <div className="flex-1 relative" style={{ minHeight: "2.5rem" }}>
                  <div className="absolute inset-0 flex pointer-events-none">
                    {TIMELINE_HOURS.map((h) => (
                      <div key={h} className="flex-1 border-r border-gray-100" />
                    ))}
                  </div>

                  {tab === "staff" &&
                    getUnavailableRanges(row.id).map((range, i) => (
                      <div
                        key={`unavail-${i}`}
                        className="absolute top-0 bottom-0 bg-gray-200/60"
                        style={{ left: range.left, width: range.width }}
                        title="対応不可"
                      />
                    ))}

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
