"use client";

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  User,
  Clock,
  Loader2,
} from "lucide-react";
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  parseISO,
  isSameDay,
  getDay,
} from "date-fns";
import { ja } from "date-fns/locale";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScheduleEntry {
  id: string;
  user_id: string;
  user_name: string;
  visit_date: string;
  start_time: string | null;
  end_time: string | null;
  service_type: string;
  staff_name: string | null;
}

const SERVICE_TYPE_COLORS: Record<string, { bg: string; text: string }> = {
  身体介護: { bg: "bg-blue-100", text: "text-blue-700" },
  生活援助: { bg: "bg-green-100", text: "text-green-700" },
  "身体・生活": { bg: "bg-purple-100", text: "text-purple-700" },
  通院等乗降介助: { bg: "bg-orange-100", text: "text-orange-700" },
};

const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function VisitSchedulePage() {
  const supabase = createClient();

  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [entries, setEntries] = useState<ScheduleEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);

  const monthLabel = format(currentMonth, "yyyy年M月", { locale: ja });

  const days = useMemo(() => {
    return eachDayOfInterval({
      start: startOfMonth(currentMonth),
      end: endOfMonth(currentMonth),
    });
  }, [currentMonth]);

  const fetchEntries = async (month: Date) => {
    setLoading(true);
    const from = format(startOfMonth(month), "yyyy-MM-dd");
    const to = format(endOfMonth(month), "yyyy-MM-dd");

    const { data, error } = await supabase
      .from("kaigo_visit_records")
      .select(`
        id,
        user_id,
        visit_date,
        start_time,
        end_time,
        service_type,
        clients(name),
        members(name)
      `)
      .gte("visit_date", from)
      .lte("visit_date", to)
      .order("visit_date")
      .order("start_time");

    if (error) {
      toast.error("予定の取得に失敗しました");
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
      const mapped: ScheduleEntry[] = (data || []).map((r: any) => ({
        id: r.id,
        user_id: r.user_id,
        user_name: r.clients?.name ?? "不明",
        visit_date: r.visit_date,
        start_time: r.start_time,
        end_time: r.end_time,
        service_type: r.service_type,
        staff_name: r.members?.name ?? null,
      }));
      setEntries(mapped);
    }
    setLoading(false);
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    fetchEntries(currentMonth);
    setSelectedDay(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMonth]);

  const prevMonth = () => {
    setCurrentMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1));
  };
  const nextMonth = () => {
    setCurrentMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1));
  };

  const entriesForDay = (day: Date) =>
    entries.filter((e) => isSameDay(parseISO(e.visit_date), day));

  const selectedDayEntries = selectedDay ? entriesForDay(selectedDay) : [];

  // Leading blank cells for calendar grid
  const firstDow = getDay(days[0]); // 0=Sun

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b bg-white px-6 py-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">予定管理</h1>
          <p className="mt-0.5 text-xs text-gray-500">訪問介護の月間訪問予定カレンダー</p>
        </div>
        {/* Month selector */}
        <div className="flex items-center gap-2">
          <button
            onClick={prevMonth}
            className="rounded-lg border border-gray-300 p-1.5 text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="min-w-[7rem] text-center text-sm font-semibold text-gray-900">
            {monthLabel}
          </span>
          <button
            onClick={nextMonth}
            className="rounded-lg border border-gray-300 p-1.5 text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Calendar */}
        <div className="flex flex-1 flex-col overflow-hidden p-4">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-gray-400">
              <Loader2 size={20} className="animate-spin mr-2" />
              読込中...
            </div>
          ) : (
            <>
              {/* Day of week header */}
              <div className="mb-1 grid grid-cols-7 gap-1">
                {DOW_LABELS.map((d, i) => (
                  <div
                    key={d}
                    className={`py-1 text-center text-xs font-bold ${
                      i === 0 ? "text-red-500" : i === 6 ? "text-blue-500" : "text-gray-500"
                    }`}
                  >
                    {d}
                  </div>
                ))}
              </div>

              {/* Calendar grid */}
              <div className="grid flex-1 grid-cols-7 gap-1 auto-rows-fr overflow-hidden">
                {/* Leading empty cells */}
                {Array.from({ length: firstDow }).map((_, i) => (
                  <div key={`blank-${i}`} className="rounded-lg bg-gray-50" />
                ))}

                {days.map((day) => {
                  const dayEntries = entriesForDay(day);
                  const isSelected = selectedDay && isSameDay(day, selectedDay);
                  const isToday = isSameDay(day, new Date());
                  const dow = getDay(day);

                  return (
                    <button
                      key={day.toISOString()}
                      onClick={() => setSelectedDay(isSelected ? null : day)}
                      className={`relative flex flex-col rounded-lg border p-1 text-left transition-colors overflow-hidden ${
                        isSelected
                          ? "border-blue-400 bg-blue-50"
                          : "border-gray-100 bg-white hover:bg-gray-50"
                      }`}
                    >
                      <span
                        className={`mb-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full text-xs font-semibold leading-none ${
                          isToday
                            ? "bg-blue-600 text-white"
                            : dow === 0
                            ? "text-red-500"
                            : dow === 6
                            ? "text-blue-500"
                            : "text-gray-700"
                        }`}
                      >
                        {format(day, "d")}
                      </span>
                      <div className="space-y-0.5 overflow-hidden">
                        {dayEntries.slice(0, 3).map((e) => {
                          const col = SERVICE_TYPE_COLORS[e.service_type] ?? { bg: "bg-gray-100", text: "text-gray-600" };
                          return (
                            <div
                              key={e.id}
                              className={`truncate rounded px-1 py-0.5 text-[10px] font-medium leading-tight ${col.bg} ${col.text}`}
                            >
                              {e.start_time ? e.start_time.slice(0, 5) : ""} {e.user_name}
                            </div>
                          );
                        })}
                        {dayEntries.length > 3 && (
                          <div className="text-[10px] text-gray-400">
                            +{dayEntries.length - 3}件
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Day detail panel */}
        <div className="w-72 overflow-y-auto border-l bg-white p-4">
          {selectedDay ? (
            <>
              <h2 className="mb-3 text-sm font-bold text-gray-900 flex items-center gap-2">
                <CalendarDays size={14} className="text-blue-500" />
                {format(selectedDay, "M月d日(E)", { locale: ja })}
                <span className="ml-auto text-xs font-normal text-gray-500">
                  {selectedDayEntries.length}件
                </span>
              </h2>

              {selectedDayEntries.length === 0 ? (
                <p className="text-xs text-gray-400">この日の訪問予定はありません</p>
              ) : (
                <div className="space-y-2">
                  {selectedDayEntries.map((e) => {
                    const col = SERVICE_TYPE_COLORS[e.service_type] ?? { bg: "bg-gray-100", text: "text-gray-600" };
                    return (
                      <div
                        key={e.id}
                        className="rounded-lg border border-gray-100 bg-gray-50 p-3"
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${col.bg} ${col.text}`}>
                            {e.service_type}
                          </span>
                        </div>
                        <p className="flex items-center gap-1 text-sm font-semibold text-gray-900">
                          <User size={12} className="text-gray-400" />
                          {e.user_name}
                        </p>
                        {(e.start_time || e.end_time) && (
                          <p className="mt-0.5 flex items-center gap-1 text-xs text-gray-500">
                            <Clock size={11} />
                            {e.start_time ?? ""}
                            {e.start_time && e.end_time ? " 〜 " : ""}
                            {e.end_time ?? ""}
                          </p>
                        )}
                        {e.staff_name && (
                          <p className="mt-0.5 text-xs text-gray-400">担当: {e.staff_name}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-gray-400">
              <div className="text-center">
                <CalendarDays size={24} className="mx-auto mb-2 text-gray-300" />
                <p>日付を選択すると<br />詳細が表示されます</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Summary bar */}
      <div className="flex items-center gap-6 border-t bg-white px-6 py-2 text-xs text-gray-500">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-blue-400" />
          身体介護
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-green-400" />
          生活援助
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-purple-400" />
          身体・生活
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-orange-400" />
          通院等乗降介助
        </span>
        <span className="ml-auto font-medium text-gray-700">
          {monthLabel}合計: {entries.length}件
        </span>
      </div>
    </div>
  );
}
