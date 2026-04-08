"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { createBrowserClient } from "@supabase/ssr";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
  Save,
  Loader2,
  CalendarDays,
  AlertCircle,
  Download,
  X,
  Clock,
  User,
  Calendar,
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
import { use } from "react";

// ─── Supabase (anon, no auth) ─────────────────────────────────────────────────

function createAnonClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface StaffInfo {
  id: string;
  name: string;
  name_kana: string;
}

interface BaseSlot {
  id?: string;
  tempId: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
}

interface MonthlySlot {
  id?: string;
  tempId: string;
  available_date: string;
  start_time: string;
  end_time: string;
  is_available: boolean;
}

interface VisitScheduleEntry {
  id: string;
  user_id: string;
  visit_date: string;
  start_time: string;
  end_time: string;
  service_type: string;
  status: string;
  notes: string | null;
  user_name: string;
}

const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

const SERVICE_TYPE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  "身体介護": { bg: "bg-orange-50", text: "text-orange-700", border: "border-orange-200" },
  "生活援助": { bg: "bg-green-50", text: "text-green-700", border: "border-green-200" },
  "身体・生活": { bg: "bg-purple-50", text: "text-purple-700", border: "border-purple-200" },
  "通院等乗降介助": { bg: "bg-sky-50", text: "text-sky-700", border: "border-sky-200" },
};

function genId() {
  return Math.random().toString(36).slice(2);
}

function emptyBaseSlot(dow: number): BaseSlot {
  return {
    tempId: genId(),
    day_of_week: dow,
    start_time: "09:00",
    end_time: "18:00",
  };
}

function emptyMonthlySlot(dateStr: string): MonthlySlot {
  return {
    tempId: genId(),
    available_date: dateStr,
    start_time: "09:00",
    end_time: "18:00",
    is_available: true,
  };
}

function getServiceColor(serviceType: string) {
  return SERVICE_TYPE_COLORS[serviceType] || { bg: "bg-gray-50", text: "text-gray-700", border: "border-gray-200" };
}

// ─── Base Settings Tab (Mobile) ──────────────────────────────────────────────

function BaseSettingsTab({ staffId }: { staffId: string }) {
  const supabase = createAnonClient();
  const [slots, setSlots] = useState<BaseSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expandedDow, setExpandedDow] = useState<number | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const { data } = await supabase
        .from("kaigo_staff_availability_base")
        .select("id, staff_id, day_of_week, start_time, end_time")
        .eq("staff_id", staffId)
        .order("day_of_week")
        .order("start_time");

      if (data && data.length > 0) {
        setSlots(
          data.map((r: any) => ({
            id: r.id,
            tempId: genId(),
            day_of_week: r.day_of_week,
            start_time: r.start_time,
            end_time: r.end_time,
          }))
        );
      } else {
        setSlots(
          [1, 2, 3, 4, 5].map((dow) => ({
            tempId: genId(),
            day_of_week: dow,
            start_time: "09:00",
            end_time: "18:00",
          }))
        );
      }
      setLoading(false);
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staffId]);

  const addSlot = (dow: number) => {
    setSlots((prev) => [...prev, emptyBaseSlot(dow)]);
  };

  const removeSlot = (tempId: string) => {
    setSlots((prev) => prev.filter((s) => s.tempId !== tempId));
  };

  const changeSlot = (tempId: string, field: keyof BaseSlot, value: string | boolean) => {
    setSlots((prev) =>
      prev.map((s) => (s.tempId === tempId ? { ...s, [field]: value } : s))
    );
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await supabase
        .from("kaigo_staff_availability_base")
        .delete()
        .eq("staff_id", staffId);

      if (slots.length > 0) {
        const rows = slots.map((s) => ({
          staff_id: staffId,
          day_of_week: s.day_of_week,
          start_time: s.start_time,
          end_time: s.end_time,
        }));
        const { error } = await supabase
          .from("kaigo_staff_availability_base")
          .insert(rows);
        if (error) throw error;
      }
      toast.success("ベース設定を保存しました");
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === "object" && err !== null
          ? JSON.stringify(err)
          : String(err);
      toast.error("保存に失敗しました: " + msg);
    } finally {
      setSaving(false);
    }
  };

  const slotsForDow = (dow: number) => slots.filter((s) => s.day_of_week === dow);

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 size={28} className="animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="space-y-3 pb-24">
      <p className="text-sm text-gray-600 px-1">
        週間の勤務可能時間帯を設定してください。月別設定の「ベースから取り込み」で各月に反映されます。
      </p>

      {/* Mobile: vertical list of days */}
      <div className="space-y-2">
        {Array.from({ length: 7 }, (_, i) => i).map((dow) => {
          const isSun = dow === 0;
          const isSat = dow === 6;
          const daySlots = slotsForDow(dow);
          const isExpanded = expandedDow === dow;
          const hasSlots = daySlots.length > 0;

          return (
            <div
              key={dow}
              className={cn(
                "rounded-xl border overflow-hidden transition-all",
                isSun ? "border-red-200" : isSat ? "border-blue-200" : "border-gray-200"
              )}
            >
              {/* Day header - tap to expand */}
              <button
                onClick={() => setExpandedDow(isExpanded ? null : dow)}
                className={cn(
                  "w-full flex items-center justify-between px-4 py-3 min-h-[52px]",
                  isSun
                    ? "bg-red-50"
                    : isSat
                    ? "bg-blue-50"
                    : hasSlots
                    ? "bg-white"
                    : "bg-gray-50"
                )}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      "text-base font-bold w-8 h-8 flex items-center justify-center rounded-full",
                      isSun
                        ? "text-red-600 bg-red-100"
                        : isSat
                        ? "text-blue-600 bg-blue-100"
                        : "text-gray-700 bg-gray-100"
                    )}
                  >
                    {DOW_LABELS[dow]}
                  </span>
                  {hasSlots ? (
                    <div className="flex flex-wrap gap-1.5">
                      {daySlots.map((slot) => (
                        <span
                          key={slot.tempId}
                          className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full"
                        >
                          {slot.start_time.slice(0, 5)}〜{slot.end_time.slice(0, 5)}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-sm text-gray-400">対応不可</span>
                  )}
                </div>
                <ChevronRight
                  size={18}
                  className={cn(
                    "text-gray-400 transition-transform",
                    isExpanded && "rotate-90"
                  )}
                />
              </button>

              {/* Expanded content */}
              {isExpanded && (
                <div className="border-t bg-white p-4 space-y-3">
                  {daySlots.map((slot) => (
                    <div
                      key={slot.tempId}
                      className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3"
                    >
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-gray-500 w-12">開始</label>
                          <input
                            type="time"
                            value={slot.start_time}
                            onChange={(e) =>
                              changeSlot(slot.tempId, "start_time", e.target.value)
                            }
                            className="flex-1 rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-gray-500 w-12">終了</label>
                          <input
                            type="time"
                            value={slot.end_time}
                            onChange={(e) =>
                              changeSlot(slot.tempId, "end_time", e.target.value)
                            }
                            className="flex-1 rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          />
                        </div>
                      </div>
                      <button
                        onClick={() => removeSlot(slot.tempId)}
                        className="flex items-center justify-center w-11 h-11 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 active:bg-red-100 transition-colors"
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => addSlot(dow)}
                    className="w-full flex items-center justify-center gap-2 rounded-lg border-2 border-dashed border-gray-300 py-3 text-sm text-gray-500 hover:border-blue-400 hover:text-blue-600 active:bg-blue-50 transition-colors min-h-[48px]"
                  >
                    <Plus size={16} />
                    時間帯を追加
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Sticky save button */}
      <div className="fixed bottom-0 left-0 right-0 z-30 bg-white border-t shadow-lg p-4 safe-area-bottom">
        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-4 text-base font-bold text-white hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 transition-colors min-h-[52px]"
        >
          {saving ? (
            <Loader2 size={20} className="animate-spin" />
          ) : (
            <Save size={20} />
          )}
          ベース設定を保存
        </button>
      </div>
    </div>
  );
}

// ─── Monthly Settings Tab (Mobile) ──────────────────────────────────────────

function MonthlySettingsTab({ staffId }: { staffId: string }) {
  const supabase = createAnonClient();
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [monthlySlots, setMonthlySlots] = useState<MonthlySlot[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const days = useMemo(
    () =>
      eachDayOfInterval({
        start: startOfMonth(currentMonth),
        end: endOfMonth(currentMonth),
      }),
    [currentMonth]
  );

  const fetchMonthly = useCallback(
    async (month: Date) => {
      setLoading(true);
      const from = format(startOfMonth(month), "yyyy-MM-dd");
      const to = format(endOfMonth(month), "yyyy-MM-dd");
      const { data } = await supabase
        .from("kaigo_staff_availability_monthly")
        .select(
          "id, staff_id, available_date, start_time, end_time, is_available"
        )
        .eq("staff_id", staffId)
        .gte("available_date", from)
        .lte("available_date", to)
        .order("available_date")
        .order("start_time");

      setMonthlySlots(
        (data || []).map((r: any) => ({
          id: r.id,
          tempId: genId(),
          available_date: r.available_date,
          start_time: r.start_time,
          end_time: r.end_time,
          is_available: r.is_available,
        }))
      );
      setLoading(false);
    },
    [staffId, supabase]
  );

  useEffect(() => {
    fetchMonthly(currentMonth);
    setSelectedDate(null);
  }, [currentMonth, fetchMonthly]);

  const importFromBase = async () => {
    setImporting(true);
    try {
      const { data: baseData } = await supabase
        .from("kaigo_staff_availability_base")
        .select("day_of_week, start_time, end_time")
        .eq("staff_id", staffId);

      const base = baseData || [];
      if (base.length === 0) {
        toast.info("ベース設定がありません");
        setImporting(false);
        return;
      }

      const from = format(startOfMonth(currentMonth), "yyyy-MM-dd");
      const to = format(endOfMonth(currentMonth), "yyyy-MM-dd");

      const { error: delErr } = await supabase
        .from("kaigo_staff_availability_monthly")
        .delete()
        .eq("staff_id", staffId)
        .gte("available_date", from)
        .lte("available_date", to);
      if (delErr) throw delErr;

      const rows: Record<string, unknown>[] = [];
      for (const day of days) {
        const dow = getDay(day);
        const matchingBase = base.filter((b: any) => b.day_of_week === dow);
        if (matchingBase.length === 0) {
          rows.push({
            staff_id: staffId,
            available_date: format(day, "yyyy-MM-dd"),
            start_time: "00:00",
            end_time: "23:59",
            is_available: false,
            source: "base",
          });
        } else {
          for (const b of matchingBase) {
            rows.push({
              staff_id: staffId,
              available_date: format(day, "yyyy-MM-dd"),
              start_time: (b as any).start_time,
              end_time: (b as any).end_time,
              is_available: true,
              source: "base",
            });
          }
        }
      }

      const { error } = await supabase
        .from("kaigo_staff_availability_monthly")
        .insert(rows);
      if (error) throw error;

      toast.success("ベース設定を取り込みました");
      fetchMonthly(currentMonth);
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === "object" && err !== null
          ? JSON.stringify(err)
          : String(err);
      toast.error("取り込みに失敗しました: " + msg);
    } finally {
      setImporting(false);
    }
  };

  const addSlotToDate = (dateStr: string) => {
    setMonthlySlots((prev) => [...prev, emptyMonthlySlot(dateStr)]);
  };

  const removeSlot = (tempId: string) => {
    setMonthlySlots((prev) => prev.filter((s) => s.tempId !== tempId));
  };

  const changeSlot = (
    tempId: string,
    field: keyof MonthlySlot,
    value: string | boolean
  ) => {
    setMonthlySlots((prev) =>
      prev.map((s) => (s.tempId === tempId ? { ...s, [field]: value } : s))
    );
  };

  const handleSaveMonth = async () => {
    setSaving(true);
    try {
      const from = format(startOfMonth(currentMonth), "yyyy-MM-dd");
      const to = format(endOfMonth(currentMonth), "yyyy-MM-dd");

      await supabase
        .from("kaigo_staff_availability_monthly")
        .delete()
        .eq("staff_id", staffId)
        .gte("available_date", from)
        .lte("available_date", to);

      if (monthlySlots.length > 0) {
        const rows = monthlySlots.map((s) => ({
          staff_id: staffId,
          available_date: s.available_date,
          start_time: s.start_time,
          end_time: s.end_time,
          is_available: s.is_available,
          source: "manual" as const,
        }));
        const { error } = await supabase
          .from("kaigo_staff_availability_monthly")
          .insert(rows);
        if (error) throw error;
      }

      toast.success("月別設定を保存しました");
      await fetchMonthly(currentMonth);
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === "object" && err !== null
          ? JSON.stringify(err)
          : String(err);
      toast.error("保存に失敗しました: " + msg);
    } finally {
      setSaving(false);
    }
  };

  const slotsForDate = (dateStr: string) =>
    monthlySlots.filter((s) => s.available_date === dateStr);

  const isDayUnavailable = (dateStr: string) => {
    const ds = slotsForDate(dateStr);
    if (ds.length === 0) return true;
    return ds.every((s) => !s.is_available);
  };

  const firstDow = days.length > 0 ? getDay(days[0]) : 0;

  return (
    <div className="space-y-4 pb-24">
      {/* Month navigation - large arrows */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
          className="flex items-center justify-center w-12 h-12 rounded-xl border border-gray-300 hover:bg-gray-50 active:bg-gray-100 transition-colors"
        >
          <ChevronLeft size={22} />
        </button>
        <span className="text-lg font-bold text-gray-900">
          {format(currentMonth, "yyyy年M月", { locale: ja })}
        </span>
        <button
          onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
          className="flex items-center justify-center w-12 h-12 rounded-xl border border-gray-300 hover:bg-gray-50 active:bg-gray-100 transition-colors"
        >
          <ChevronRight size={22} />
        </button>
      </div>

      {/* Import button */}
      <button
        onClick={importFromBase}
        disabled={importing}
        className="w-full flex items-center justify-center gap-2 rounded-xl border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 active:bg-gray-100 disabled:opacity-50 transition-colors min-h-[48px]"
      >
        {importing ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <Download size={16} />
        )}
        ベースから取り込み
      </button>

      {loading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 size={28} className="animate-spin text-blue-500" />
        </div>
      ) : (
        <>
          {/* Calendar grid - mobile optimized */}
          <div className="grid grid-cols-7 gap-0.5">
            {/* DoW header */}
            {DOW_LABELS.map((d, i) => (
              <div
                key={d}
                className={cn(
                  "text-center text-xs font-bold py-2",
                  i === 0
                    ? "text-red-500"
                    : i === 6
                    ? "text-blue-500"
                    : "text-gray-500"
                )}
              >
                {d}
              </div>
            ))}
            {/* Leading blanks */}
            {Array.from({ length: firstDow }).map((_, i) => (
              <div key={`blank-${i}`} className="aspect-square" />
            ))}
            {/* Day cells */}
            {days.map((day) => {
              const dateStr = format(day, "yyyy-MM-dd");
              const dow = getDay(day);
              const isToday = isSameDay(day, new Date());
              const unavail = isDayUnavailable(dateStr);
              const isSelected = selectedDate === dateStr;
              const daySlots = slotsForDate(dateStr);
              const availCount = daySlots.filter((s) => s.is_available).length;

              return (
                <button
                  key={dateStr}
                  onClick={() =>
                    setSelectedDate(isSelected ? null : dateStr)
                  }
                  className={cn(
                    "aspect-square flex flex-col items-center justify-center rounded-lg transition-all relative min-h-[44px]",
                    isSelected
                      ? "bg-blue-100 ring-2 ring-blue-500"
                      : unavail
                      ? "bg-gray-100"
                      : "bg-green-50"
                  )}
                >
                  <span
                    className={cn(
                      "text-sm font-semibold leading-none",
                      isToday
                        ? "bg-blue-600 text-white w-7 h-7 rounded-full flex items-center justify-center"
                        : dow === 0
                        ? "text-red-500"
                        : dow === 6
                        ? "text-blue-500"
                        : unavail
                        ? "text-gray-400"
                        : "text-gray-700"
                    )}
                  >
                    {format(day, "d")}
                  </span>
                  {/* Indicator dot */}
                  {!unavail && availCount > 0 && (
                    <div className="w-1.5 h-1.5 rounded-full bg-green-500 mt-0.5" />
                  )}
                  {unavail && daySlots.length > 0 && (
                    <div className="w-1.5 h-1.5 rounded-full bg-gray-400 mt-0.5" />
                  )}
                </button>
              );
            })}
          </div>

          {/* Legend */}
          <div className="flex items-center justify-center gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded bg-green-50 border border-green-200" />
              対応可
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded bg-gray-100 border border-gray-300" />
              対応不可
            </span>
          </div>
        </>
      )}

      {/* Selected day edit panel - mobile sheet */}
      {selectedDate && (
        <div className="rounded-2xl border bg-white shadow-lg overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b">
            <h3 className="text-base font-bold text-gray-900">
              {format(
                new Date(selectedDate + "T00:00:00"),
                "M月d日(E)",
                { locale: ja }
              )}
            </h3>
            <button
              onClick={() => setSelectedDate(null)}
              className="w-10 h-10 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 active:bg-gray-200"
            >
              <X size={20} />
            </button>
          </div>

          <div className="p-4 space-y-3">
            {slotsForDate(selectedDate).length === 0 ? (
              <div className="text-center py-6">
                <p className="text-sm text-gray-400 mb-3">
                  この日は対応不可（スロットなし）
                </p>
                <button
                  onClick={() => addSlotToDate(selectedDate)}
                  className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-sm font-medium text-white hover:bg-blue-700 active:bg-blue-800 min-h-[48px]"
                >
                  <Plus size={16} />
                  時間帯を追加
                </button>
              </div>
            ) : (
              <>
                {slotsForDate(selectedDate).map((slot) => (
                  <div
                    key={slot.tempId}
                    className={cn(
                      "rounded-xl border p-3 space-y-2",
                      slot.is_available
                        ? "bg-white border-gray-200"
                        : "bg-gray-50 border-gray-200"
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <label className="flex items-center gap-2 cursor-pointer min-h-[44px]">
                        <input
                          type="checkbox"
                          checked={slot.is_available}
                          onChange={(e) =>
                            changeSlot(
                              slot.tempId,
                              "is_available",
                              e.target.checked
                            )
                          }
                          className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span
                          className={cn(
                            "text-sm font-medium",
                            slot.is_available
                              ? "text-green-600"
                              : "text-gray-400"
                          )}
                        >
                          {slot.is_available ? "対応可" : "対応不可"}
                        </span>
                      </label>
                      <button
                        onClick={() => removeSlot(slot.tempId)}
                        className="w-11 h-11 flex items-center justify-center rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 active:bg-red-100 transition-colors"
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="time"
                        value={slot.start_time}
                        onChange={(e) =>
                          changeSlot(
                            slot.tempId,
                            "start_time",
                            e.target.value
                          )
                        }
                        disabled={!slot.is_available}
                        className="flex-1 rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-40 disabled:bg-gray-100"
                      />
                      <span className="text-gray-400 text-sm">〜</span>
                      <input
                        type="time"
                        value={slot.end_time}
                        onChange={(e) =>
                          changeSlot(
                            slot.tempId,
                            "end_time",
                            e.target.value
                          )
                        }
                        disabled={!slot.is_available}
                        className="flex-1 rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-40 disabled:bg-gray-100"
                      />
                    </div>
                  </div>
                ))}
                <button
                  onClick={() => addSlotToDate(selectedDate)}
                  className="w-full flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 py-3 text-sm text-gray-500 hover:border-blue-400 hover:text-blue-600 active:bg-blue-50 transition-colors min-h-[48px]"
                >
                  <Plus size={16} />
                  時間帯を追加
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Sticky save button */}
      <div className="fixed bottom-0 left-0 right-0 z-30 bg-white border-t shadow-lg p-4 safe-area-bottom">
        <button
          onClick={handleSaveMonth}
          disabled={saving}
          className="w-full flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-4 text-base font-bold text-white hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 transition-colors min-h-[52px]"
        >
          {saving ? (
            <Loader2 size={20} className="animate-spin" />
          ) : (
            <Save size={20} />
          )}
          月別設定を保存
        </button>
      </div>
    </div>
  );
}

// ─── My Shift Tab (Mobile) ───────────────────────────────────────────────────

function MyShiftTab({ staffId }: { staffId: string }) {
  const supabase = createAnonClient();
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [schedules, setSchedules] = useState<VisitScheduleEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const days = useMemo(
    () =>
      eachDayOfInterval({
        start: startOfMonth(currentMonth),
        end: endOfMonth(currentMonth),
      }),
    [currentMonth]
  );

  const fetchSchedules = useCallback(
    async (month: Date) => {
      setLoading(true);
      const from = format(startOfMonth(month), "yyyy-MM-dd");
      const to = format(endOfMonth(month), "yyyy-MM-dd");

      const { data, error } = await supabase
        .from("kaigo_visit_schedule")
        .select(
          "id, user_id, visit_date, start_time, end_time, service_type, status, notes, kaigo_users(name)"
        )
        .eq("staff_id", staffId)
        .gte("visit_date", from)
        .lte("visit_date", to)
        .neq("status", "cancelled")
        .order("visit_date")
        .order("start_time");

      if (error) {
        console.error("Failed to fetch schedules:", error);
        setSchedules([]);
      } else {
        setSchedules(
          (data || []).map((r: any) => ({
            id: r.id,
            user_id: r.user_id,
            visit_date: r.visit_date,
            start_time: r.start_time,
            end_time: r.end_time,
            service_type: r.service_type,
            status: r.status,
            notes: r.notes,
            user_name: r.kaigo_users?.name || "不明",
          }))
        );
      }
      setLoading(false);
    },
    [staffId, supabase]
  );

  useEffect(() => {
    fetchSchedules(currentMonth);
    setSelectedDate(null);
  }, [currentMonth, fetchSchedules]);

  const schedulesForDate = (dateStr: string) =>
    schedules.filter((s) => s.visit_date === dateStr);

  const firstDow = days.length > 0 ? getDay(days[0]) : 0;

  // Count visits per day for quick summary
  const visitCountMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const s of schedules) {
      map[s.visit_date] = (map[s.visit_date] || 0) + 1;
    }
    return map;
  }, [schedules]);

  // Unique service types per day for color dots
  const serviceTypesForDate = (dateStr: string) => {
    const types = new Set(schedulesForDate(dateStr).map((s) => s.service_type));
    return Array.from(types);
  };

  const selectedSchedules = selectedDate
    ? schedulesForDate(selectedDate)
    : [];

  return (
    <div className="space-y-4 pb-6">
      {/* Month navigation */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
          className="flex items-center justify-center w-12 h-12 rounded-xl border border-gray-300 hover:bg-gray-50 active:bg-gray-100 transition-colors"
        >
          <ChevronLeft size={22} />
        </button>
        <span className="text-lg font-bold text-gray-900">
          {format(currentMonth, "yyyy年M月", { locale: ja })}
        </span>
        <button
          onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
          className="flex items-center justify-center w-12 h-12 rounded-xl border border-gray-300 hover:bg-gray-50 active:bg-gray-100 transition-colors"
        >
          <ChevronRight size={22} />
        </button>
      </div>

      {loading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 size={28} className="animate-spin text-blue-500" />
        </div>
      ) : (
        <>
          {/* Calendar grid */}
          <div className="grid grid-cols-7 gap-0.5">
            {/* DoW header */}
            {DOW_LABELS.map((d, i) => (
              <div
                key={d}
                className={cn(
                  "text-center text-xs font-bold py-2",
                  i === 0
                    ? "text-red-500"
                    : i === 6
                    ? "text-blue-500"
                    : "text-gray-500"
                )}
              >
                {d}
              </div>
            ))}
            {/* Leading blanks */}
            {Array.from({ length: firstDow }).map((_, i) => (
              <div key={`blank-${i}`} className="aspect-square" />
            ))}
            {/* Day cells */}
            {days.map((day) => {
              const dateStr = format(day, "yyyy-MM-dd");
              const dow = getDay(day);
              const isToday = isSameDay(day, new Date());
              const isSelected = selectedDate === dateStr;
              const count = visitCountMap[dateStr] || 0;
              const types = serviceTypesForDate(dateStr);

              return (
                <button
                  key={dateStr}
                  onClick={() =>
                    setSelectedDate(isSelected ? null : dateStr)
                  }
                  className={cn(
                    "aspect-square flex flex-col items-center justify-center rounded-lg transition-all relative min-h-[44px]",
                    isSelected
                      ? "bg-blue-100 ring-2 ring-blue-500"
                      : count > 0
                      ? "bg-blue-50"
                      : "bg-white"
                  )}
                >
                  <span
                    className={cn(
                      "text-sm font-semibold leading-none",
                      isToday
                        ? "bg-blue-600 text-white w-7 h-7 rounded-full flex items-center justify-center"
                        : dow === 0
                        ? "text-red-500"
                        : dow === 6
                        ? "text-blue-500"
                        : "text-gray-700"
                    )}
                  >
                    {format(day, "d")}
                  </span>
                  {/* Service type color dots */}
                  {count > 0 && (
                    <div className="flex items-center gap-0.5 mt-0.5">
                      {types.slice(0, 3).map((t, idx) => {
                        const color = getServiceColor(t);
                        return (
                          <div
                            key={idx}
                            className={cn(
                              "w-1.5 h-1.5 rounded-full",
                              t === "身体介護"
                                ? "bg-orange-400"
                                : t === "生活援助"
                                ? "bg-green-500"
                                : t === "身体・生活"
                                ? "bg-purple-500"
                                : "bg-sky-500"
                            )}
                          />
                        );
                      })}
                      {count > 1 && (
                        <span className="text-[9px] text-gray-500 ml-0.5 font-medium">
                          {count}
                        </span>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Service type legend */}
          <div className="flex flex-wrap items-center justify-center gap-3 text-xs text-gray-500">
            {Object.entries(SERVICE_TYPE_COLORS).map(([type, colors]) => (
              <span key={type} className="flex items-center gap-1">
                <span
                  className={cn(
                    "w-3 h-3 rounded border",
                    colors.bg,
                    colors.border
                  )}
                />
                {type}
              </span>
            ))}
          </div>

          {/* Monthly summary */}
          <div className="rounded-xl bg-gray-50 border border-gray-200 p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-600">今月の訪問件数</span>
              <span className="font-bold text-gray-900 text-lg">
                {schedules.length}件
              </span>
            </div>
          </div>
        </>
      )}

      {/* Selected day detail - full-width card */}
      {selectedDate && (
        <div className="rounded-2xl border bg-white shadow-lg overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b">
            <h3 className="text-base font-bold text-gray-900">
              {format(
                new Date(selectedDate + "T00:00:00"),
                "M月d日(E)",
                { locale: ja }
              )}
              の予定
            </h3>
            <button
              onClick={() => setSelectedDate(null)}
              className="w-10 h-10 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 active:bg-gray-200"
            >
              <X size={20} />
            </button>
          </div>

          <div className="p-4">
            {selectedSchedules.length === 0 ? (
              <div className="text-center py-8 text-gray-400">
                <Calendar size={32} className="mx-auto mb-2 opacity-50" />
                <p className="text-sm">この日の予定はありません</p>
              </div>
            ) : (
              <div className="space-y-3">
                {selectedSchedules.map((sched) => {
                  const color = getServiceColor(sched.service_type);
                  return (
                    <div
                      key={sched.id}
                      className={cn(
                        "rounded-xl border p-4",
                        color.bg,
                        color.border
                      )}
                    >
                      <div className="flex items-start justify-between">
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-2">
                            <Clock size={14} className={color.text} />
                            <span
                              className={cn(
                                "text-sm font-bold",
                                color.text
                              )}
                            >
                              {sched.start_time.slice(0, 5)}〜
                              {sched.end_time.slice(0, 5)}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <User size={14} className="text-gray-500" />
                            <span className="text-sm font-medium text-gray-800">
                              {sched.user_name}
                            </span>
                          </div>
                          <span
                            className={cn(
                              "inline-block text-xs font-medium px-2.5 py-1 rounded-full",
                              color.bg,
                              color.text,
                              "border",
                              color.border
                            )}
                          >
                            {sched.service_type}
                          </span>
                          {sched.status === "changed" && (
                            <span className="inline-block text-xs font-medium px-2.5 py-1 rounded-full bg-yellow-50 text-yellow-700 border border-yellow-200 ml-1">
                              変更あり
                            </span>
                          )}
                        </div>
                      </div>
                      {sched.notes && (
                        <p className="mt-2 text-xs text-gray-600 bg-white/60 rounded-lg p-2">
                          {sched.notes}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type TabKey = "shift" | "base" | "monthly";

const TABS: { key: TabKey; label: string; icon: typeof CalendarDays }[] = [
  { key: "shift", label: "マイシフト", icon: Calendar },
  { key: "base", label: "ベース設定", icon: CalendarDays },
  { key: "monthly", label: "月別設定", icon: CalendarDays },
];

type Params = { token: string };

export default function StaffAvailabilityPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { token } = use(params);
  const supabase = createAnonClient();
  const [staff, setStaff] = useState<StaffInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [invalid, setInvalid] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("shift");

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const { data: tokenData, error: tokenError } = await supabase
        .from("kaigo_staff_tokens")
        .select("staff_id, token")
        .eq("token", token)
        .single();

      if (tokenError || !tokenData) {
        setInvalid(true);
        setLoading(false);
        return;
      }

      const { data: staffData, error: staffError } = await supabase
        .from("kaigo_staff")
        .select("id, name, name_kana")
        .eq("id", tokenData.staff_id)
        .single();

      if (staffError || !staffData) {
        setInvalid(true);
        setLoading(false);
        return;
      }

      setStaff(staffData as StaffInfo);
      setLoading(false);
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <Loader2 size={36} className="animate-spin text-blue-500 mx-auto" />
          <p className="mt-3 text-sm text-gray-500">読み込み中...</p>
        </div>
      </div>
    );
  }

  if (invalid || !staff) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6">
        <div className="max-w-sm w-full text-center">
          <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
            <AlertCircle size={32} className="text-red-500" />
          </div>
          <h1 className="text-xl font-bold text-gray-900 mb-2">
            無効なURL
          </h1>
          <p className="text-sm text-gray-500 leading-relaxed">
            このURLは無効か期限切れです。
            <br />
            管理者にご連絡ください。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header - sticky */}
      <header className="bg-white border-b shadow-sm sticky top-0 z-20">
        <div className="px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
              <User size={20} className="text-blue-600" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-bold text-gray-900 truncate">
                {staff.name}
              </h1>
              <p className="text-xs text-gray-500">勤務可能時間・シフト管理</p>
            </div>
          </div>
        </div>

        {/* Tabs - full width, large */}
        <div className="flex border-t">
          {TABS.map((tab) => {
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 py-3 text-sm font-medium border-b-2 transition-colors min-h-[48px]",
                  isActive
                    ? "border-blue-600 text-blue-700 bg-blue-50/50"
                    : "border-transparent text-gray-500 hover:text-gray-700 active:bg-gray-50"
                )}
              >
                <tab.icon size={16} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 px-4 py-4 max-w-lg mx-auto w-full">
        {activeTab === "shift" && <MyShiftTab staffId={staff.id} />}
        {activeTab === "base" && <BaseSettingsTab staffId={staff.id} />}
        {activeTab === "monthly" && <MonthlySettingsTab staffId={staff.id} />}
      </main>
    </div>
  );
}
