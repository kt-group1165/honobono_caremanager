"use client";

import { useMemo } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  AlertTriangle,
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
  SERVICE_TYPE_COLORS,
  isStaffUnavailableAtTime,
  type StaffAvailabilitySlot,
  type VisitSchedule,
} from "./_shared";
import { useKaigoVisitSchedulesByStaff } from "@/lib/swr/use-kaigo-visit-schedules";
import { useKaigoAvailability } from "@/lib/swr/use-kaigo-availability";

export interface StaffCalendarInitialData {
  schedules: VisitSchedule[];
  availability: StaffAvailabilitySlot[];
}

interface StaffCalendarProps {
  staffId: string;
  staffName: string;
  currentMonth: Date;
  onMonthChange: (d: Date) => void;
  onEditSchedule?: (sched: VisitSchedule) => void;
  initialData: StaffCalendarInitialData;
}

export function StaffCalendar({
  staffId,
  staffName,
  currentMonth,
  onMonthChange,
  onEditSchedule,
  initialData,
}: StaffCalendarProps) {
  const monthFrom = useMemo(() => format(startOfMonth(currentMonth), "yyyy-MM-dd"), [currentMonth]);
  const monthTo = useMemo(() => format(endOfMonth(currentMonth), "yyyy-MM-dd"), [currentMonth]);

  // SWR fallbackData は initial mount でのみ有効 (key が変わると消える)。
  // → 現 prop が "initial" と整合する場合のみ fallback として渡す。
  const initialSchedules = initialData.schedules.length > 0 || initialData.availability.length > 0
    ? initialData.schedules
    : undefined;
  const initialAvailability = initialData.availability.length > 0 ? initialData.availability : undefined;

  const {
    schedules,
    isLoading: schedLoading,
  } = useKaigoVisitSchedulesByStaff(staffId, monthFrom, monthTo, initialSchedules);
  const {
    availability,
    isLoading: availLoading,
  } = useKaigoAvailability(staffId, monthFrom, monthTo, initialAvailability);

  const loading = schedLoading || availLoading;

  const days = useMemo(
    () =>
      eachDayOfInterval({
        start: startOfMonth(currentMonth),
        end: endOfMonth(currentMonth),
      }),
    [currentMonth]
  );

  const isDayUnavailable = (dateStr: string) => {
    if (availability.length === 0) return false;
    const slots = availability.filter((a) => a.available_date === dateStr);
    if (slots.length === 0) return true;
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
                              ? "bg-yellow-50 text-yellow-700 font-semibold hover:bg-yellow-100"
                              : isCompleted
                              ? "bg-red-50 text-red-600 font-semibold hover:bg-red-100"
                              : cn(col, "hover:opacity-80")
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

          <div className="mt-3 rounded-lg border bg-gray-50 px-4 py-2 text-sm text-gray-600">
            今月の訪問件数:{" "}
            <span className="font-semibold text-gray-900">{schedules.length}件</span>
          </div>
        </div>
      )}
    </div>
  );
}
