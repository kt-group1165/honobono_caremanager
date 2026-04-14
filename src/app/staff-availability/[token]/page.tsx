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
  ClipboardList,
  Check,
  ChevronDown as ChevronDownIcon,
  Heart,
  Thermometer,
  Edit3,
  MapPin,
  LogIn,
  LogOut,
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

// ─── Care Record Types & Form ────────────────────────────────────────────────
// ケアパレット準拠: 各カテゴリにサブ項目（量・種類・自立度等）を持つ
// DBにはJSONBで保存するため、フォーム全体を1つのオブジェクトで管理

interface CareRecordData {
  // 1. 事前チェック
  pre_check: {
    complexion: string;     // 顔色（良好/やや不良/不良）
    condition: string;      // 体調（良好/普通/不良）
    room_temp: string;      // 室温
    humidity: string;       // 湿度
    notes: string;          // その他チェック
  };
  // 2. バイタルサイン・身体測定
  vitals: {
    temperature: string;
    bp_sys: string;
    bp_dia: string;
    pulse: string;
    spo2: string;
    respiration: string;
    blood_sugar: string;
    weight: string;         // 体重
    notes: string;
  };
  // 3. 排泄介助
  excretion: {
    done: boolean;
    urine: boolean;         // 尿
    stool: boolean;         // 便
    urine_amount: string;   // 尿量（少量/普通/多量）
    stool_amount: string;   // 便量（少量/普通/多量）
    stool_type: string;     // 便性状（普通/硬い/軟便/水様便）
    independence: string;   // 自立度（自立/一部介助/全介助）
    device: string;         // 使用器具（トイレ/ポータブルトイレ/おむつ/パッド）
    notes: string;
  };
  // 4. 水分摂取
  hydration: {
    done: boolean;
    drink_type: string;     // 飲み物の種類
    amount: string;         // 量(ml)
    thickener: string;      // とろみ（なし/薄い/中間/濃い）
    notes: string;
  };
  // 5. 食事介助
  meal: {
    done: boolean;
    staple_amount: string;  // 主食摂取量（全量/3/4/半分/1/4/なし）
    side_amount: string;    // 副食摂取量
    meal_form: string;      // 食事形態（普通/きざみ/ミキサー/ペースト/流動食）
    independence: string;   // 自立度
    notes: string;
  };
  // 6. 口腔ケア
  oral_care: {
    done: boolean;
    denture: string;        // 義歯（なし/上のみ/下のみ/上下）
    brushing: boolean;      // 歯磨き
    gargling: boolean;      // うがい
    denture_cleaning: boolean; // 義歯洗浄
    mouth_wipe: boolean;    // 口腔清拭
    notes: string;
  };
  // 7. 清拭・入浴
  bathing: {
    done: boolean;
    bath_type: string;      // 入浴種類（一般浴/シャワー浴/清拭/足浴/手浴）
    independence: string;   // 自立度
    skin_condition: string; // 皮膚状態（異常なし/発赤/褥瘡/湿疹/乾燥/その他）
    notes: string;
  };
  // 8. 身体整容
  grooming: {
    done: boolean;
    face_wash: boolean;     // 洗顔
    hair: boolean;          // 整髪
    nail: boolean;          // 爪切り
    ear: boolean;           // 耳掃除
    shaving: boolean;       // 髭剃り
    notes: string;
  };
  // 9. 更衣介助
  dressing: {
    done: boolean;
    upper: boolean;         // 上衣
    lower: boolean;         // 下衣
    independence: string;   // 自立度
    notes: string;
  };
  // 10. 体位変換・移動
  positioning: {
    done: boolean;
    position_type: string;  // 体位（仰臥位/側臥位/座位/その他）
    mobility_device: string; // 移動手段（徒歩/杖/歩行器/車椅子/ストレッチャー）
    notes: string;
  };
  // 11. 服薬介助
  medication: {
    done: boolean;
    med_type: string;       // 投与方法（内服/外用/点眼/吸入/座薬/その他）
    confirmed: boolean;     // 服薬確認済み
    notes: string;
  };
  // 12. 通院・外出介助
  outing: {
    done: boolean;
    outing_type: string;    // 種類（通院/買物同行/散歩/外出付添/その他）
    transport: string;      // 移動手段（徒歩/車/公共交通/車椅子）
    notes: string;
  };
  // 13. 起床・就寝介助
  wake_sleep: {
    done: boolean;
    wake_up: boolean;       // 起床介助
    go_to_bed: boolean;     // 就寝介助
    bed_making: boolean;    // ベッドメイキング
    notes: string;
  };
  // 14. 医療的ケア
  medical_care: {
    done: boolean;
    suction: boolean;       // 吸引
    tube_feeding: boolean;  // 経管栄養
    stoma: boolean;         // ストーマ管理
    catheter: boolean;      // カテーテル管理
    wound_care: boolean;    // 創傷処置
    oxygen: boolean;        // 酸素管理
    notes: string;
  };
  // 15. 自立支援
  independence_support: {
    done: boolean;
    exercise: boolean;      // 運動・リハビリ
    cognitive: boolean;     // 認知機能訓練
    communication: boolean; // コミュニケーション支援
    social: boolean;        // 社会参加支援
    notes: string;
  };
  // 16. 生活援助
  living_support: {
    cooking: boolean;
    cooking_notes: string;
    cleaning: boolean;
    cleaning_notes: string;
    laundry: boolean;
    laundry_notes: string;
    shopping: boolean;
    shopping_notes: string;
    trash: boolean;
    clothing: boolean;
    medication_mgmt: boolean;
    health_mgmt: boolean;
    other_notes: string;
  };
  // 17. 退出確認
  exit_check: {
    fire_check: boolean;    // 火の元確認
    lock_check: boolean;    // 施錠確認
    appliance_check: boolean; // 電化製品確認
    user_condition: string; // 退出時の利用者の状態
    notes: string;
  };
  // 18. 経過記録
  progress_notes: string;
  // 19. 申し送り
  handover: {
    priority: string;       // 優先度（通常/重要）
    notes: string;
  };
  // 20. 詳細報告
  detailed_report: string;
  // 21. 写真
  photos: string[];         // 写真URL配列（Supabase Storageに保存）
  // 22. サイン（署名）
  signature: string;        // 署名データ（base64 PNG）
  // 23. 入退室記録
  entry: {
    time: string;           // ISO string
    lat: number | null;
    lng: number | null;
    accuracy: number | null; // メートル
  } | null;
  exit: {
    time: string;
    lat: number | null;
    lng: number | null;
    accuracy: number | null;
  } | null;
  // その他
  user_condition: string;
  notes: string;
}

const emptyCareRecord = (): CareRecordData => ({
  pre_check: { complexion: "", condition: "", room_temp: "", humidity: "", notes: "" },
  vitals: { temperature: "", bp_sys: "", bp_dia: "", pulse: "", spo2: "", respiration: "", blood_sugar: "", weight: "", notes: "" },
  excretion: { done: false, urine: false, stool: false, urine_amount: "", stool_amount: "", stool_type: "", independence: "", device: "", notes: "" },
  hydration: { done: false, drink_type: "", amount: "", thickener: "", notes: "" },
  meal: { done: false, staple_amount: "", side_amount: "", meal_form: "", independence: "", notes: "" },
  oral_care: { done: false, denture: "", brushing: false, gargling: false, denture_cleaning: false, mouth_wipe: false, notes: "" },
  bathing: { done: false, bath_type: "", independence: "", skin_condition: "", notes: "" },
  grooming: { done: false, face_wash: false, hair: false, nail: false, ear: false, shaving: false, notes: "" },
  dressing: { done: false, upper: false, lower: false, independence: "", notes: "" },
  positioning: { done: false, position_type: "", mobility_device: "", notes: "" },
  medication: { done: false, med_type: "", confirmed: false, notes: "" },
  outing: { done: false, outing_type: "", transport: "", notes: "" },
  wake_sleep: { done: false, wake_up: false, go_to_bed: false, bed_making: false, notes: "" },
  medical_care: { done: false, suction: false, tube_feeding: false, stoma: false, catheter: false, wound_care: false, oxygen: false, notes: "" },
  independence_support: { done: false, exercise: false, cognitive: false, communication: false, social: false, notes: "" },
  living_support: { cooking: false, cooking_notes: "", cleaning: false, cleaning_notes: "", laundry: false, laundry_notes: "", shopping: false, shopping_notes: "", trash: false, clothing: false, medication_mgmt: false, health_mgmt: false, other_notes: "" },
  exit_check: { fire_check: false, lock_check: false, appliance_check: false, user_condition: "", notes: "" },
  progress_notes: "",
  handover: { priority: "通常", notes: "" },
  detailed_report: "",
  photos: [],
  signature: "",
  entry: null,
  exit: null,
  user_condition: "",
  notes: "",
});

interface ExistingRecord {
  id: string;
  schedule_id: string | null;
  user_id: string;
  visit_date: string;
  start_time: string;
  end_time: string;
  body_care: Record<string, unknown>;
  living_support: Record<string, unknown>;
  vital_temperature: number | null;
  vital_bp_sys: number | null;
  vital_bp_dia: number | null;
  vital_pulse: number | null;
  vital_spo2: number | null;
  vital_respiration: number | null;
  vital_blood_sugar: number | null;
  user_condition: string | null;
  handover_notes: string | null;
  notes: string | null;
  progress_notes: string | null;
  care_record_data: CareRecordData | null;  // JSONB列に全データ保存
}

// ─── Helper UI Components ──────────────────────────────────────────────────

function SectionBtn({ id, label, active, onClick }: { id: string; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center justify-between w-full px-4 py-3 bg-gray-50 border-y border-gray-200 active:bg-gray-100",
      )}
    >
      <span className={cn("text-sm font-bold", active ? "text-blue-700" : "text-gray-700")}>{label}</span>
      <ChevronDownIcon size={16} className={cn("text-gray-400 transition-transform", active && "rotate-180")} />
    </button>
  );
}

function CareCheckbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn(
        "flex items-center gap-2 px-3 py-2.5 rounded-xl border text-sm font-medium transition-all active:scale-95",
        checked ? "bg-blue-50 border-blue-300 text-blue-700" : "bg-white border-gray-200 text-gray-600"
      )}
    >
      <span className={cn(
        "w-5 h-5 rounded flex items-center justify-center shrink-0 border",
        checked ? "bg-blue-500 border-blue-500" : "bg-white border-gray-300"
      )}>
        {checked && <Check size={14} className="text-white" />}
      </span>
      {label}
    </button>
  );
}

function CareSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-gray-300 px-3 py-3 text-base bg-white focus:border-blue-500 focus:outline-none"
      >
        <option value="">選択してください</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

function CareInput({ label, value, onChange, placeholder, type = "text", inputMode }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; inputMode?: "numeric" | "decimal" | "text" }) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      <input
        type={type}
        inputMode={inputMode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-xl border border-gray-300 px-3 py-3 text-base focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
    </div>
  );
}

function CareTextarea({ label, value, onChange, placeholder, rows = 3 }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; rows?: number }) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="w-full rounded-xl border border-gray-300 px-3 py-3 text-base resize-none focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
    </div>
  );
}

// セクション定義（ケアパレット準拠 20カテゴリ）
const CARE_SECTIONS = [
  { id: "pre_check", label: "事前チェック" },
  { id: "vitals", label: "バイタルサイン・身体測定" },
  { id: "excretion", label: "排泄介助" },
  { id: "hydration", label: "水分摂取" },
  { id: "meal", label: "食事介助" },
  { id: "oral_care", label: "口腔ケア" },
  { id: "bathing", label: "清拭・入浴" },
  { id: "grooming", label: "身体整容" },
  { id: "dressing", label: "更衣介助" },
  { id: "positioning", label: "体位変換・移動" },
  { id: "medication", label: "服薬介助" },
  { id: "outing", label: "通院・外出介助" },
  { id: "wake_sleep", label: "起床・就寝介助" },
  { id: "medical_care", label: "医療的ケア" },
  { id: "independence_support", label: "自立支援" },
  { id: "living", label: "生活援助" },
  { id: "exit_check", label: "退出確認" },
  { id: "progress", label: "経過記録" },
  { id: "handover", label: "申し送り等" },
  { id: "detailed_report", label: "詳細報告" },
  { id: "photos", label: "写真" },
  { id: "signature", label: "サイン" },
] as const;

function CareRecordModal({
  sched,
  staffId,
  existingRecord,
  onClose,
  onSaved,
}: {
  sched: VisitScheduleEntry;
  staffId: string;
  existingRecord: ExistingRecord | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  // New comprehensive care record form — stores everything in care_record_data JSONB
  const supabase = createAnonClient();
  const [data, setData] = useState<CareRecordData>(() => {
    if (existingRecord?.care_record_data) return { ...emptyCareRecord(), ...existingRecord.care_record_data };
    // Legacy fallback: migrate from old columns
    if (existingRecord) {
      const d = emptyCareRecord();
      d.vitals.temperature = existingRecord.vital_temperature?.toString() ?? "";
      d.vitals.bp_sys = existingRecord.vital_bp_sys?.toString() ?? "";
      d.vitals.bp_dia = existingRecord.vital_bp_dia?.toString() ?? "";
      d.vitals.pulse = existingRecord.vital_pulse?.toString() ?? "";
      d.vitals.spo2 = existingRecord.vital_spo2?.toString() ?? "";
      d.vitals.respiration = existingRecord.vital_respiration?.toString() ?? "";
      d.vitals.blood_sugar = existingRecord.vital_blood_sugar?.toString() ?? "";
      d.user_condition = existingRecord.user_condition ?? "";
      d.handover.notes = existingRecord.handover_notes ?? "";
      d.notes = existingRecord.notes ?? "";
      d.progress_notes = existingRecord.progress_notes ?? "";
      return d;
    }
    return emptyCareRecord();
  });
  const [saving, setSaving] = useState(false);
  const [openSection, setOpenSection] = useState<string | null>("pre_check");

  // Helper to update nested data
  const upd = <K extends keyof CareRecordData>(key: K, val: Partial<CareRecordData[K]>) => {
    setData((prev) => ({ ...prev, [key]: typeof prev[key] === "object" && !Array.isArray(prev[key]) ? { ...(prev[key] as Record<string, unknown>), ...val } : val }));
  };

  const handleSave = async () => {
    setSaving(true);
    const payload = {
      user_id: sched.user_id,
      visit_date: sched.visit_date,
      staff_id: staffId,
      service_type: sched.service_type,
      start_time: sched.start_time,
      end_time: sched.end_time,
      schedule_id: sched.id,
      care_record_data: data,
      // Also write to legacy columns for backward compat
      vital_temperature: data.vitals.temperature ? parseFloat(data.vitals.temperature) : null,
      vital_bp_sys: data.vitals.bp_sys ? parseInt(data.vitals.bp_sys) : null,
      vital_bp_dia: data.vitals.bp_dia ? parseInt(data.vitals.bp_dia) : null,
      vital_pulse: data.vitals.pulse ? parseInt(data.vitals.pulse) : null,
      vital_spo2: data.vitals.spo2 ? parseInt(data.vitals.spo2) : null,
      vital_respiration: data.vitals.respiration ? parseInt(data.vitals.respiration) : null,
      vital_blood_sugar: data.vitals.blood_sugar ? parseInt(data.vitals.blood_sugar) : null,
      user_condition: data.user_condition || null,
      handover_notes: data.handover.notes || null,
      notes: data.notes || null,
      progress_notes: data.progress_notes || null,
      status: "draft",
    };
    let error;
    if (existingRecord) {
      ({ error } = await supabase.from("kaigo_visit_records").update(payload).eq("id", existingRecord.id));
    } else {
      ({ error } = await supabase.from("kaigo_visit_records").insert(payload));
    }
    if (error) { toast.error("保存に失敗しました: " + error.message); }
    else { toast.success(existingRecord ? "記録を更新しました" : "記録を保存しました"); onSaved(); onClose(); }
    setSaving(false);
  };

  const toggle = (id: string) => setOpenSection(openSection === id ? null : id);
  const isOpen = (id: string) => openSection === id;

  return (
    <div className="fixed inset-0 z-50 bg-white flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-white shrink-0">
        <button onClick={onClose} className="text-gray-500 active:text-gray-700 p-1"><X size={24} /></button>
        <h2 className="text-base font-bold text-gray-900">{existingRecord ? "記録を編集" : "記録入力"}</h2>
        <button onClick={handleSave} disabled={saving} className="flex items-center gap-1 px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-bold active:bg-blue-700 disabled:opacity-50">
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}保存
        </button>
      </div>

      {/* Schedule info */}
      <div className="px-4 py-2 bg-blue-50 border-b border-blue-100 shrink-0">
        <div className="flex items-center gap-2">
          <User size={14} className="text-blue-600" />
          <span className="text-sm font-bold text-blue-900">{sched.user_name}</span>
          <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", getServiceColor(sched.service_type).bg, getServiceColor(sched.service_type).text, "border", getServiceColor(sched.service_type).border)}>{sched.service_type}</span>
        </div>
        <div className="flex items-center gap-1 mt-0.5 text-xs text-blue-700">
          <Clock size={12} />
          {format(new Date(sched.visit_date + "T00:00:00"), "M月d日(E)", { locale: ja })} {sched.start_time.slice(0, 5)}~{sched.end_time.slice(0, 5)}
        </div>
      </div>

      {/* Form body — 22 sections */}
      <div className="flex-1 overflow-auto">

        {/* 1. 事前チェック */}
        <SectionBtn id="pre_check" label="事前チェック" active={isOpen("pre_check")} onClick={() => toggle("pre_check")} />
        {isOpen("pre_check") && (
          <div className="p-4 space-y-3">
            <CareSelect label="顔色" value={data.pre_check.complexion} onChange={(v) => upd("pre_check", { complexion: v })} options={["良好", "やや不良", "不良"]} />
            <CareSelect label="体調" value={data.pre_check.condition} onChange={(v) => upd("pre_check", { condition: v })} options={["良好", "普通", "不良"]} />
            <div className="grid grid-cols-2 gap-3">
              <CareInput label="室温 (℃)" value={data.pre_check.room_temp} onChange={(v) => upd("pre_check", { room_temp: v })} placeholder="25" inputMode="decimal" />
              <CareInput label="湿度 (%)" value={data.pre_check.humidity} onChange={(v) => upd("pre_check", { humidity: v })} placeholder="50" inputMode="numeric" />
            </div>
            <CareTextarea label="その他" value={data.pre_check.notes} onChange={(v) => upd("pre_check", { notes: v })} rows={2} />
          </div>
        )}

        {/* 2. バイタルサイン・身体測定 */}
        <SectionBtn id="vitals" label="バイタルサイン・身体測定" active={isOpen("vitals")} onClick={() => toggle("vitals")} />
        {isOpen("vitals") && (
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <CareInput label="体温 (℃)" value={data.vitals.temperature} onChange={(v) => upd("vitals", { temperature: v })} placeholder="36.5" inputMode="decimal" />
              <CareInput label="SpO2 (%)" value={data.vitals.spo2} onChange={(v) => upd("vitals", { spo2: v })} placeholder="98" inputMode="numeric" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">血圧 (mmHg)</label>
              <div className="flex items-center gap-2">
                <input type="number" inputMode="numeric" value={data.vitals.bp_sys} onChange={(e) => upd("vitals", { bp_sys: e.target.value })} placeholder="120" className="flex-1 rounded-xl border border-gray-300 px-3 py-3 text-base text-center focus:border-blue-500 focus:outline-none" />
                <span className="text-gray-400 font-bold">/</span>
                <input type="number" inputMode="numeric" value={data.vitals.bp_dia} onChange={(e) => upd("vitals", { bp_dia: e.target.value })} placeholder="80" className="flex-1 rounded-xl border border-gray-300 px-3 py-3 text-base text-center focus:border-blue-500 focus:outline-none" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <CareInput label="脈拍 (bpm)" value={data.vitals.pulse} onChange={(v) => upd("vitals", { pulse: v })} placeholder="72" inputMode="numeric" />
              <CareInput label="呼吸数 (回/分)" value={data.vitals.respiration} onChange={(v) => upd("vitals", { respiration: v })} placeholder="18" inputMode="numeric" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <CareInput label="血糖値 (mg/dL)" value={data.vitals.blood_sugar} onChange={(v) => upd("vitals", { blood_sugar: v })} placeholder="100" inputMode="numeric" />
              <CareInput label="体重 (kg)" value={data.vitals.weight} onChange={(v) => upd("vitals", { weight: v })} placeholder="60.0" inputMode="decimal" />
            </div>
            <CareTextarea label="備考" value={data.vitals.notes} onChange={(v) => upd("vitals", { notes: v })} rows={2} />
          </div>
        )}

        {/* 3. 排泄介助 */}
        <SectionBtn id="excretion" label="排泄介助" active={isOpen("excretion")} onClick={() => toggle("excretion")} />
        {isOpen("excretion") && (
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <CareCheckbox label="尿" checked={data.excretion.urine} onChange={(v) => upd("excretion", { urine: v, done: v || data.excretion.stool })} />
              <CareCheckbox label="便" checked={data.excretion.stool} onChange={(v) => upd("excretion", { stool: v, done: data.excretion.urine || v })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <CareSelect label="尿量" value={data.excretion.urine_amount} onChange={(v) => upd("excretion", { urine_amount: v })} options={["少量", "普通", "多量"]} />
              <CareSelect label="便量" value={data.excretion.stool_amount} onChange={(v) => upd("excretion", { stool_amount: v })} options={["少量", "普通", "多量"]} />
            </div>
            <CareSelect label="便性状" value={data.excretion.stool_type} onChange={(v) => upd("excretion", { stool_type: v })} options={["普通", "硬い", "軟便", "水様便"]} />
            <CareSelect label="自立度" value={data.excretion.independence} onChange={(v) => upd("excretion", { independence: v })} options={["自立", "見守り", "一部介助", "全介助"]} />
            <CareSelect label="使用器具" value={data.excretion.device} onChange={(v) => upd("excretion", { device: v })} options={["トイレ", "ポータブルトイレ", "おむつ", "パッド", "尿器"]} />
            <CareTextarea label="備考" value={data.excretion.notes} onChange={(v) => upd("excretion", { notes: v })} rows={2} />
          </div>
        )}

        {/* 4. 水分摂取 */}
        <SectionBtn id="hydration" label="水分摂取" active={isOpen("hydration")} onClick={() => toggle("hydration")} />
        {isOpen("hydration") && (
          <div className="p-4 space-y-3">
            <CareInput label="飲み物の種類" value={data.hydration.drink_type} onChange={(v) => upd("hydration", { drink_type: v, done: true })} placeholder="お茶、水、ジュース等" />
            <CareInput label="量 (ml)" value={data.hydration.amount} onChange={(v) => upd("hydration", { amount: v })} placeholder="200" inputMode="numeric" />
            <CareSelect label="とろみ" value={data.hydration.thickener} onChange={(v) => upd("hydration", { thickener: v })} options={["なし", "薄い", "中間", "濃い"]} />
            <CareTextarea label="備考" value={data.hydration.notes} onChange={(v) => upd("hydration", { notes: v })} rows={2} />
          </div>
        )}

        {/* 5. 食事介助 */}
        <SectionBtn id="meal" label="食事介助" active={isOpen("meal")} onClick={() => toggle("meal")} />
        {isOpen("meal") && (
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <CareSelect label="主食摂取量" value={data.meal.staple_amount} onChange={(v) => upd("meal", { staple_amount: v, done: true })} options={["全量", "3/4", "半分", "1/4", "少量", "なし"]} />
              <CareSelect label="副食摂取量" value={data.meal.side_amount} onChange={(v) => upd("meal", { side_amount: v })} options={["全量", "3/4", "半分", "1/4", "少量", "なし"]} />
            </div>
            <CareSelect label="食事形態" value={data.meal.meal_form} onChange={(v) => upd("meal", { meal_form: v })} options={["普通", "きざみ", "ミキサー", "ペースト", "流動食"]} />
            <CareSelect label="自立度" value={data.meal.independence} onChange={(v) => upd("meal", { independence: v })} options={["自立", "見守り", "一部介助", "全介助"]} />
            <CareTextarea label="備考" value={data.meal.notes} onChange={(v) => upd("meal", { notes: v })} rows={2} />
          </div>
        )}

        {/* 6. 口腔ケア */}
        <SectionBtn id="oral_care" label="口腔ケア" active={isOpen("oral_care")} onClick={() => toggle("oral_care")} />
        {isOpen("oral_care") && (
          <div className="p-4 space-y-3">
            <CareSelect label="義歯" value={data.oral_care.denture} onChange={(v) => upd("oral_care", { denture: v })} options={["なし", "上のみ", "下のみ", "上下"]} />
            <div className="grid grid-cols-2 gap-2">
              <CareCheckbox label="歯磨き" checked={data.oral_care.brushing} onChange={(v) => upd("oral_care", { brushing: v, done: true })} />
              <CareCheckbox label="うがい" checked={data.oral_care.gargling} onChange={(v) => upd("oral_care", { gargling: v, done: true })} />
              <CareCheckbox label="義歯洗浄" checked={data.oral_care.denture_cleaning} onChange={(v) => upd("oral_care", { denture_cleaning: v, done: true })} />
              <CareCheckbox label="口腔清拭" checked={data.oral_care.mouth_wipe} onChange={(v) => upd("oral_care", { mouth_wipe: v, done: true })} />
            </div>
            <CareTextarea label="備考" value={data.oral_care.notes} onChange={(v) => upd("oral_care", { notes: v })} rows={2} />
          </div>
        )}

        {/* 7. 清拭・入浴 */}
        <SectionBtn id="bathing" label="清拭・入浴" active={isOpen("bathing")} onClick={() => toggle("bathing")} />
        {isOpen("bathing") && (
          <div className="p-4 space-y-3">
            <CareSelect label="入浴種類" value={data.bathing.bath_type} onChange={(v) => upd("bathing", { bath_type: v, done: true })} options={["一般浴", "シャワー浴", "清拭", "足浴", "手浴", "部分浴"]} />
            <CareSelect label="自立度" value={data.bathing.independence} onChange={(v) => upd("bathing", { independence: v })} options={["自立", "見守り", "一部介助", "全介助"]} />
            <CareSelect label="皮膚状態" value={data.bathing.skin_condition} onChange={(v) => upd("bathing", { skin_condition: v })} options={["異常なし", "発赤", "褥瘡", "湿疹", "乾燥", "傷", "その他"]} />
            <CareTextarea label="備考" value={data.bathing.notes} onChange={(v) => upd("bathing", { notes: v })} rows={2} />
          </div>
        )}

        {/* 8. 身体整容 */}
        <SectionBtn id="grooming" label="身体整容" active={isOpen("grooming")} onClick={() => toggle("grooming")} />
        {isOpen("grooming") && (
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <CareCheckbox label="洗顔" checked={data.grooming.face_wash} onChange={(v) => upd("grooming", { face_wash: v, done: true })} />
              <CareCheckbox label="整髪" checked={data.grooming.hair} onChange={(v) => upd("grooming", { hair: v, done: true })} />
              <CareCheckbox label="爪切り" checked={data.grooming.nail} onChange={(v) => upd("grooming", { nail: v, done: true })} />
              <CareCheckbox label="耳掃除" checked={data.grooming.ear} onChange={(v) => upd("grooming", { ear: v, done: true })} />
              <CareCheckbox label="髭剃り" checked={data.grooming.shaving} onChange={(v) => upd("grooming", { shaving: v, done: true })} />
            </div>
            <CareTextarea label="備考" value={data.grooming.notes} onChange={(v) => upd("grooming", { notes: v })} rows={2} />
          </div>
        )}

        {/* 9. 更衣介助 */}
        <SectionBtn id="dressing" label="更衣介助" active={isOpen("dressing")} onClick={() => toggle("dressing")} />
        {isOpen("dressing") && (
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <CareCheckbox label="上衣" checked={data.dressing.upper} onChange={(v) => upd("dressing", { upper: v, done: true })} />
              <CareCheckbox label="下衣" checked={data.dressing.lower} onChange={(v) => upd("dressing", { lower: v, done: true })} />
            </div>
            <CareSelect label="自立度" value={data.dressing.independence} onChange={(v) => upd("dressing", { independence: v })} options={["自立", "見守り", "一部介助", "全介助"]} />
            <CareTextarea label="備考" value={data.dressing.notes} onChange={(v) => upd("dressing", { notes: v })} rows={2} />
          </div>
        )}

        {/* 10. 体位変換・移動 */}
        <SectionBtn id="positioning" label="体位変換・移動" active={isOpen("positioning")} onClick={() => toggle("positioning")} />
        {isOpen("positioning") && (
          <div className="p-4 space-y-3">
            <CareSelect label="体位" value={data.positioning.position_type} onChange={(v) => upd("positioning", { position_type: v, done: true })} options={["仰臥位", "側臥位", "座位", "半座位", "起立位", "その他"]} />
            <CareSelect label="移動手段" value={data.positioning.mobility_device} onChange={(v) => upd("positioning", { mobility_device: v })} options={["徒歩", "杖", "歩行器", "車椅子", "ストレッチャー", "その他"]} />
            <CareTextarea label="備考" value={data.positioning.notes} onChange={(v) => upd("positioning", { notes: v })} rows={2} />
          </div>
        )}

        {/* 11. 服薬介助 */}
        <SectionBtn id="medication" label="服薬介助" active={isOpen("medication")} onClick={() => toggle("medication")} />
        {isOpen("medication") && (
          <div className="p-4 space-y-3">
            <CareSelect label="投与方法" value={data.medication.med_type} onChange={(v) => upd("medication", { med_type: v, done: true })} options={["内服", "外用", "点眼", "吸入", "座薬", "注射", "その他"]} />
            <CareCheckbox label="服薬確認済み" checked={data.medication.confirmed} onChange={(v) => upd("medication", { confirmed: v })} />
            <CareTextarea label="備考" value={data.medication.notes} onChange={(v) => upd("medication", { notes: v })} rows={2} />
          </div>
        )}

        {/* 12. 通院・外出介助 */}
        <SectionBtn id="outing" label="通院・外出介助" active={isOpen("outing")} onClick={() => toggle("outing")} />
        {isOpen("outing") && (
          <div className="p-4 space-y-3">
            <CareSelect label="種類" value={data.outing.outing_type} onChange={(v) => upd("outing", { outing_type: v, done: true })} options={["通院", "買物同行", "散歩", "外出付添", "その他"]} />
            <CareSelect label="移動手段" value={data.outing.transport} onChange={(v) => upd("outing", { transport: v })} options={["徒歩", "車", "公共交通", "車椅子", "その他"]} />
            <CareTextarea label="備考" value={data.outing.notes} onChange={(v) => upd("outing", { notes: v })} rows={2} />
          </div>
        )}

        {/* 13. 起床・就寝介助 */}
        <SectionBtn id="wake_sleep" label="起床・就寝介助" active={isOpen("wake_sleep")} onClick={() => toggle("wake_sleep")} />
        {isOpen("wake_sleep") && (
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <CareCheckbox label="起床介助" checked={data.wake_sleep.wake_up} onChange={(v) => upd("wake_sleep", { wake_up: v, done: true })} />
              <CareCheckbox label="就寝介助" checked={data.wake_sleep.go_to_bed} onChange={(v) => upd("wake_sleep", { go_to_bed: v, done: true })} />
              <CareCheckbox label="ベッドメイキング" checked={data.wake_sleep.bed_making} onChange={(v) => upd("wake_sleep", { bed_making: v, done: true })} />
            </div>
            <CareTextarea label="備考" value={data.wake_sleep.notes} onChange={(v) => upd("wake_sleep", { notes: v })} rows={2} />
          </div>
        )}

        {/* 14. 医療的ケア */}
        <SectionBtn id="medical_care" label="医療的ケア" active={isOpen("medical_care")} onClick={() => toggle("medical_care")} />
        {isOpen("medical_care") && (
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <CareCheckbox label="吸引" checked={data.medical_care.suction} onChange={(v) => upd("medical_care", { suction: v, done: true })} />
              <CareCheckbox label="経管栄養" checked={data.medical_care.tube_feeding} onChange={(v) => upd("medical_care", { tube_feeding: v, done: true })} />
              <CareCheckbox label="ストーマ管理" checked={data.medical_care.stoma} onChange={(v) => upd("medical_care", { stoma: v, done: true })} />
              <CareCheckbox label="カテーテル管理" checked={data.medical_care.catheter} onChange={(v) => upd("medical_care", { catheter: v, done: true })} />
              <CareCheckbox label="創傷処置" checked={data.medical_care.wound_care} onChange={(v) => upd("medical_care", { wound_care: v, done: true })} />
              <CareCheckbox label="酸素管理" checked={data.medical_care.oxygen} onChange={(v) => upd("medical_care", { oxygen: v, done: true })} />
            </div>
            <CareTextarea label="備考" value={data.medical_care.notes} onChange={(v) => upd("medical_care", { notes: v })} rows={2} />
          </div>
        )}

        {/* 15. 自立支援 */}
        <SectionBtn id="independence" label="自立支援" active={isOpen("independence")} onClick={() => toggle("independence")} />
        {isOpen("independence") && (
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <CareCheckbox label="運動・リハビリ" checked={data.independence_support.exercise} onChange={(v) => upd("independence_support", { exercise: v, done: true })} />
              <CareCheckbox label="認知機能訓練" checked={data.independence_support.cognitive} onChange={(v) => upd("independence_support", { cognitive: v, done: true })} />
              <CareCheckbox label="コミュニケーション" checked={data.independence_support.communication} onChange={(v) => upd("independence_support", { communication: v, done: true })} />
              <CareCheckbox label="社会参加支援" checked={data.independence_support.social} onChange={(v) => upd("independence_support", { social: v, done: true })} />
            </div>
            <CareTextarea label="備考" value={data.independence_support.notes} onChange={(v) => upd("independence_support", { notes: v })} rows={2} />
          </div>
        )}

        {/* 16. 生活援助 */}
        <SectionBtn id="living" label="生活援助" active={isOpen("living")} onClick={() => toggle("living")} />
        {isOpen("living") && (
          <div className="p-4 space-y-3">
            <CareCheckbox label="調理" checked={data.living_support.cooking} onChange={(v) => upd("living_support", { cooking: v })} />
            {data.living_support.cooking && <CareTextarea label="調理の内容" value={data.living_support.cooking_notes} onChange={(v) => upd("living_support", { cooking_notes: v })} rows={2} />}
            <CareCheckbox label="掃除" checked={data.living_support.cleaning} onChange={(v) => upd("living_support", { cleaning: v })} />
            {data.living_support.cleaning && <CareTextarea label="掃除の内容" value={data.living_support.cleaning_notes} onChange={(v) => upd("living_support", { cleaning_notes: v })} rows={2} />}
            <CareCheckbox label="洗濯" checked={data.living_support.laundry} onChange={(v) => upd("living_support", { laundry: v })} />
            {data.living_support.laundry && <CareTextarea label="洗濯の内容" value={data.living_support.laundry_notes} onChange={(v) => upd("living_support", { laundry_notes: v })} rows={2} />}
            <CareCheckbox label="買物" checked={data.living_support.shopping} onChange={(v) => upd("living_support", { shopping: v })} />
            {data.living_support.shopping && <CareTextarea label="買物の内容" value={data.living_support.shopping_notes} onChange={(v) => upd("living_support", { shopping_notes: v })} rows={2} />}
            <div className="grid grid-cols-2 gap-2">
              <CareCheckbox label="ゴミ出し" checked={data.living_support.trash} onChange={(v) => upd("living_support", { trash: v })} />
              <CareCheckbox label="衣類の整理" checked={data.living_support.clothing} onChange={(v) => upd("living_support", { clothing: v })} />
              <CareCheckbox label="服薬管理" checked={data.living_support.medication_mgmt} onChange={(v) => upd("living_support", { medication_mgmt: v })} />
              <CareCheckbox label="健康管理" checked={data.living_support.health_mgmt} onChange={(v) => upd("living_support", { health_mgmt: v })} />
            </div>
            <CareTextarea label="その他" value={data.living_support.other_notes} onChange={(v) => upd("living_support", { other_notes: v })} rows={2} />
          </div>
        )}

        {/* 17. 退出確認 */}
        <SectionBtn id="exit_check" label="退出確認" active={isOpen("exit_check")} onClick={() => toggle("exit_check")} />
        {isOpen("exit_check") && (
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <CareCheckbox label="火の元確認" checked={data.exit_check.fire_check} onChange={(v) => upd("exit_check", { fire_check: v })} />
              <CareCheckbox label="施錠確認" checked={data.exit_check.lock_check} onChange={(v) => upd("exit_check", { lock_check: v })} />
              <CareCheckbox label="電化製品確認" checked={data.exit_check.appliance_check} onChange={(v) => upd("exit_check", { appliance_check: v })} />
            </div>
            <CareTextarea label="退出時の利用者の状態" value={data.exit_check.user_condition} onChange={(v) => upd("exit_check", { user_condition: v })} rows={2} />
            <CareTextarea label="備考" value={data.exit_check.notes} onChange={(v) => upd("exit_check", { notes: v })} rows={2} />
          </div>
        )}

        {/* 18. 経過記録 */}
        <SectionBtn id="progress" label="経過記録" active={isOpen("progress")} onClick={() => toggle("progress")} />
        {isOpen("progress") && (
          <div className="p-4">
            <CareTextarea label="経過記録" value={data.progress_notes} onChange={(v) => setData({ ...data, progress_notes: v })} placeholder="サービス提供中の経過を記録..." rows={5} />
          </div>
        )}

        {/* 19. 申し送り等 */}
        <SectionBtn id="handover" label="申し送り等" active={isOpen("handover")} onClick={() => toggle("handover")} />
        {isOpen("handover") && (
          <div className="p-4 space-y-3">
            <CareSelect label="優先度" value={data.handover.priority} onChange={(v) => upd("handover", { priority: v })} options={["通常", "重要"]} />
            <CareTextarea label="申し送り内容" value={data.handover.notes} onChange={(v) => upd("handover", { notes: v })} placeholder="次の担当者への申し送り..." rows={4} />
            <CareTextarea label="利用者の状態" value={data.user_condition} onChange={(v) => setData({ ...data, user_condition: v })} rows={3} />
            <CareTextarea label="特記事項" value={data.notes} onChange={(v) => setData({ ...data, notes: v })} rows={2} />
          </div>
        )}

        {/* 20. 詳細報告 */}
        <SectionBtn id="detailed_report" label="詳細報告" active={isOpen("detailed_report")} onClick={() => toggle("detailed_report")} />
        {isOpen("detailed_report") && (
          <div className="p-4">
            <CareTextarea label="詳細報告" value={data.detailed_report} onChange={(v) => setData({ ...data, detailed_report: v })} placeholder="詳細な報告内容を記入..." rows={6} />
          </div>
        )}

        {/* 21. 写真 */}
        <SectionBtn id="photos" label="写真" active={isOpen("photos")} onClick={() => toggle("photos")} />
        {isOpen("photos") && (
          <div className="p-4 space-y-3">
            <p className="text-xs text-gray-500">サービス中の写真を撮影・添付できます</p>
            <label className="flex items-center justify-center gap-2 w-full py-4 rounded-xl border-2 border-dashed border-gray-300 text-gray-500 active:bg-gray-50 cursor-pointer">
              <Plus size={20} />
              <span className="text-sm font-medium">写真を追加</span>
              <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                  setData((prev) => ({ ...prev, photos: [...prev.photos, reader.result as string] }));
                };
                reader.readAsDataURL(file);
              }} />
            </label>
            {data.photos.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {data.photos.map((p, i) => (
                  <div key={i} className="relative aspect-square rounded-lg overflow-hidden border">
                    <img src={p} alt="" className="w-full h-full object-cover" />
                    <button onClick={() => setData((prev) => ({ ...prev, photos: prev.photos.filter((_, j) => j !== i) }))} className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/50 flex items-center justify-center text-white"><X size={12} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 22. サイン */}
        <SectionBtn id="signature" label="サイン" active={isOpen("signature")} onClick={() => toggle("signature")} />
        {isOpen("signature") && (
          <div className="p-4 space-y-3">
            <p className="text-xs text-gray-500">サービス提供の確認サインを記入してください</p>
            {data.signature ? (
              <div className="space-y-2">
                <div className="border rounded-xl p-2 bg-gray-50">
                  <img src={data.signature} alt="署名" className="w-full h-24 object-contain" />
                </div>
                <button onClick={() => setData({ ...data, signature: "" })} className="text-xs text-red-500 font-medium">署名をクリア</button>
              </div>
            ) : (
              <div className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center text-gray-400 text-sm">
                <p>署名機能は次期アップデートで追加予定です</p>
                <p className="text-xs mt-1">（Canvas署名パッド）</p>
              </div>
            )}
          </div>
        )}

        <div className="h-8" />
      </div>
    </div>
  );
}

// ─── My Shift Tab ────────────────────────────────────────────────────────────

function MyShiftTab({ staffId }: { staffId: string }) {
  const supabase = createAnonClient();
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [schedules, setSchedules] = useState<VisitScheduleEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [records, setRecords] = useState<ExistingRecord[]>([]);
  const [recordFormTarget, setRecordFormTarget] = useState<VisitScheduleEntry | null>(null);
  const [showCalendar, setShowCalendar] = useState(false);
  const [calMonth, setCalMonth] = useState(() => new Date());
  const [shiftDates, setShiftDates] = useState<Set<string>>(new Set());

  const dateStr = format(currentDate, "yyyy-MM-dd");

  // Fetch which dates in a month have shifts (for calendar dots)
  const fetchShiftDates = useCallback(async (month: Date) => {
    const from = format(startOfMonth(month), "yyyy-MM-dd");
    const to = format(endOfMonth(month), "yyyy-MM-dd");
    const { data } = await supabase
      .from("kaigo_visit_schedule")
      .select("visit_date")
      .eq("staff_id", staffId)
      .gte("visit_date", from)
      .lte("visit_date", to)
      .neq("status", "cancelled");
    const dates = new Set<string>();
    (data || []).forEach((r: { visit_date: string }) => dates.add(r.visit_date));
    setShiftDates(dates);
  }, [staffId, supabase]);

  // When calendar opens or month changes, fetch shift dates
  useEffect(() => {
    if (showCalendar) fetchShiftDates(calMonth);
  }, [showCalendar, calMonth, fetchShiftDates]);

  const fetchSchedules = useCallback(
    async (date: Date) => {
      setLoading(true);
      const ds = format(date, "yyyy-MM-dd");
      const { data, error } = await supabase
        .from("kaigo_visit_schedule")
        .select("id, user_id, visit_date, start_time, end_time, service_type, status, notes, kaigo_users(name)")
        .eq("staff_id", staffId)
        .eq("visit_date", ds)
        .neq("status", "cancelled")
        .order("start_time");
      if (error) { setSchedules([]); }
      else {
        setSchedules((data || []).map((r: any) => ({
          id: r.id, user_id: r.user_id, visit_date: r.visit_date,
          start_time: r.start_time, end_time: r.end_time,
          service_type: r.service_type, status: r.status, notes: r.notes,
          user_name: r.kaigo_users?.name || "不明",
        })));
      }
      setLoading(false);
    },
    [staffId, supabase]
  );

  const fetchRecords = useCallback(
    async (date: Date) => {
      const ds = format(date, "yyyy-MM-dd");
      const { data } = await supabase
        .from("kaigo_visit_records")
        .select("id, schedule_id, user_id, visit_date, start_time, end_time, body_care, living_support, vital_temperature, vital_bp_sys, vital_bp_dia, vital_pulse, vital_spo2, vital_respiration, vital_blood_sugar, user_condition, handover_notes, notes, progress_notes, care_record_data")
        .eq("staff_id", staffId)
        .eq("visit_date", ds);
      setRecords((data || []) as ExistingRecord[]);
    },
    [staffId, supabase]
  );

  const refreshRecords = () => fetchRecords(currentDate);

  useEffect(() => {
    fetchSchedules(currentDate);
    fetchRecords(currentDate);
  }, [currentDate, fetchSchedules, fetchRecords]);

  const getRecordForSchedule = (sched: VisitScheduleEntry): ExistingRecord | null => {
    const byId = records.find((r) => r.schedule_id === sched.id);
    if (byId) return byId;
    return records.find(
      (r) => r.user_id === sched.user_id && r.visit_date === sched.visit_date && r.start_time === sched.start_time
    ) ?? null;
  };

  const hasRecord = (sched: VisitScheduleEntry) => getRecordForSchedule(sched) !== null;

  // 入退室記録の取得（care_record_dataから）
  const getEntryExit = (sched: VisitScheduleEntry) => {
    const rec = getRecordForSchedule(sched);
    const crd = (rec as any)?.care_record_data;  // eslint-disable-line @typescript-eslint/no-explicit-any
    return { entry: crd?.entry ?? null, exit: crd?.exit ?? null, recordId: rec?.id ?? null };
  };

  // GPS取得ヘルパー
  const getPosition = (): Promise<{ lat: number; lng: number; accuracy: number }> => {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error("位置情報に対応していません")); return; }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
        (err) => reject(new Error(err.code === 1 ? "位置情報の許可が必要です" : "位置情報を取得できませんでした")),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  };

  // 入室ボタン
  const handleEntry = async (sched: VisitScheduleEntry) => {
    try {
      toast.info("位置情報を取得中...");
      const pos = await getPosition();
      const now = new Date().toISOString();
      const entryData = { time: now, lat: pos.lat, lng: pos.lng, accuracy: Math.round(pos.accuracy) };

      const existing = getRecordForSchedule(sched);
      if (existing) {
        // 既存レコードを更新
        const crd = (existing as any).care_record_data || emptyCareRecord();  // eslint-disable-line @typescript-eslint/no-explicit-any
        crd.entry = entryData;
        await supabase.from("kaigo_visit_records").update({
          care_record_data: crd,
          start_time: format(new Date(), "HH:mm:ss"),
        }).eq("id", existing.id);
      } else {
        // 新規レコード作成
        const crd = emptyCareRecord();
        crd.entry = entryData;
        await supabase.from("kaigo_visit_records").insert({
          user_id: sched.user_id, visit_date: sched.visit_date, staff_id: staffId,
          service_type: sched.service_type, schedule_id: sched.id,
          start_time: format(new Date(), "HH:mm:ss"), end_time: sched.end_time,
          care_record_data: crd, status: "draft",
        });
      }
      toast.success("入室を記録しました");
      refreshRecords();
    } catch (err: any) {  // eslint-disable-line @typescript-eslint/no-explicit-any
      toast.error(err.message || "入室記録に失敗しました");
    }
  };

  // 退室ボタン
  const handleExit = async (sched: VisitScheduleEntry) => {
    try {
      toast.info("位置情報を取得中...");
      const pos = await getPosition();
      const now = new Date().toISOString();
      const exitData = { time: now, lat: pos.lat, lng: pos.lng, accuracy: Math.round(pos.accuracy) };

      const existing = getRecordForSchedule(sched);
      if (existing) {
        const crd = (existing as any).care_record_data || emptyCareRecord();  // eslint-disable-line @typescript-eslint/no-explicit-any
        crd.exit = exitData;
        await supabase.from("kaigo_visit_records").update({
          care_record_data: crd,
          end_time: format(new Date(), "HH:mm:ss"),
        }).eq("id", existing.id);
      } else {
        const crd = emptyCareRecord();
        crd.exit = exitData;
        await supabase.from("kaigo_visit_records").insert({
          user_id: sched.user_id, visit_date: sched.visit_date, staff_id: staffId,
          service_type: sched.service_type, schedule_id: sched.id,
          start_time: sched.start_time, end_time: format(new Date(), "HH:mm:ss"),
          care_record_data: crd, status: "draft",
        });
      }
      toast.success("退室を記録しました");
      refreshRecords();
    } catch (err: any) {  // eslint-disable-line @typescript-eslint/no-explicit-any
      toast.error(err.message || "退室記録に失敗しました");
    }
  };

  const prevDay = () => setCurrentDate((d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
  const nextDay = () => setCurrentDate((d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1));
  const isToday = isSameDay(currentDate, new Date());
  const dow = getDay(currentDate);

  return (
    <div className="space-y-4 pb-6">
      {/* Date navigation */}
      <div className="flex items-center justify-between">
        <button onClick={prevDay} className="flex items-center justify-center w-10 h-10 rounded-xl border border-gray-300 hover:bg-gray-50 active:bg-gray-100 transition-colors">
          <ChevronLeft size={20} />
        </button>
        <button
          onClick={() => { setCalMonth(currentDate); setShowCalendar(true); }}
          className="text-center"
        >
          <div className="flex items-center gap-2 justify-center">
            <span className={cn(
              "text-lg font-bold border-b-2 border-dashed border-blue-300 pb-0.5",
              isToday ? "text-blue-700" : dow === 0 ? "text-red-500" : dow === 6 ? "text-blue-500" : "text-gray-900"
            )}>
              {format(currentDate, "yyyy年M月d日(E)", { locale: ja })}
            </span>
            {isToday && <span className="text-[10px] font-bold bg-blue-600 text-white px-1.5 py-0.5 rounded">今日</span>}
          </div>
        </button>
        <button onClick={nextDay} className="flex items-center justify-center w-10 h-10 rounded-xl border border-gray-300 hover:bg-gray-50 active:bg-gray-100 transition-colors">
          <ChevronRight size={20} />
        </button>
      </div>

      {/* Custom Calendar Picker Modal */}
      {showCalendar && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40" onClick={() => setShowCalendar(false)}>
          <div className="w-full max-w-sm bg-white rounded-t-2xl sm:rounded-2xl shadow-xl p-4 pb-8" onClick={(e) => e.stopPropagation()}>
            {/* Calendar month nav */}
            <div className="flex items-center justify-between mb-3">
              <button onClick={() => setCalMonth(subMonths(calMonth, 1))} className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-gray-100 active:bg-gray-200">
                <ChevronLeft size={18} />
              </button>
              <span className="text-base font-bold text-gray-900">
                {format(calMonth, "yyyy年M月", { locale: ja })}
              </span>
              <button onClick={() => setCalMonth(addMonths(calMonth, 1))} className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-gray-100 active:bg-gray-200">
                <ChevronRight size={18} />
              </button>
            </div>
            {/* DoW header */}
            <div className="grid grid-cols-7 gap-0.5 mb-1">
              {DOW_LABELS.map((d, i) => (
                <div key={d} className={cn("text-center text-xs font-bold py-1", i === 0 ? "text-red-500" : i === 6 ? "text-blue-500" : "text-gray-400")}>
                  {d}
                </div>
              ))}
            </div>
            {/* Day cells */}
            <div className="grid grid-cols-7 gap-0.5">
              {(() => {
                const monthDays = eachDayOfInterval({ start: startOfMonth(calMonth), end: endOfMonth(calMonth) });
                const blanks = getDay(monthDays[0]);
                return (
                  <>
                    {Array.from({ length: blanks }).map((_, i) => <div key={`b-${i}`} className="aspect-square" />)}
                    {monthDays.map((day) => {
                      const ds = format(day, "yyyy-MM-dd");
                      const dw = getDay(day);
                      const isSelected = ds === dateStr;
                      const hasShift = shiftDates.has(ds);
                      const isTd = isSameDay(day, new Date());
                      return (
                        <button
                          key={ds}
                          onClick={() => { setCurrentDate(day); setShowCalendar(false); }}
                          className={cn(
                            "aspect-square flex flex-col items-center justify-center rounded-lg transition-all relative min-h-[40px]",
                            isSelected ? "bg-blue-600 text-white" : isTd ? "bg-blue-50 ring-1 ring-blue-300" : "hover:bg-gray-100 active:bg-gray-200"
                          )}
                        >
                          <span className={cn(
                            "text-sm font-semibold",
                            isSelected ? "text-white" : isTd ? "text-blue-700" : dw === 0 ? "text-red-500" : dw === 6 ? "text-blue-500" : "text-gray-700"
                          )}>
                            {format(day, "d")}
                          </span>
                          {hasShift && (
                            <div className={cn("w-1.5 h-1.5 rounded-full mt-0.5", isSelected ? "bg-white" : "bg-green-500")} />
                          )}
                        </button>
                      );
                    })}
                  </>
                );
              })()}
            </div>
            {/* Today button */}
            <button
              onClick={() => { setCurrentDate(new Date()); setShowCalendar(false); }}
              className="w-full mt-3 py-2.5 rounded-xl border border-blue-200 bg-blue-50 text-blue-700 text-sm font-bold active:bg-blue-100"
            >
              今日に戻る
            </button>
          </div>
        </div>
      )}

      {/* Today button */}
      {!isToday && (
        <button
          onClick={() => setCurrentDate(new Date())}
          className="w-full text-center text-xs text-blue-600 font-medium py-1 active:text-blue-800"
        >
          今日に戻る
        </button>
      )}

      {/* Day summary */}
      <div className="rounded-xl bg-gray-50 border border-gray-200 p-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-600">この日の訪問件数</span>
          <span className="font-bold text-gray-900 text-lg">{schedules.length}件</span>
        </div>
      </div>

      {loading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 size={28} className="animate-spin text-blue-500" />
        </div>
      ) : schedules.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <Calendar size={32} className="mx-auto mb-2 opacity-50" />
          <p className="text-sm">この日の予定はありません</p>
        </div>
      ) : (
        /* 予定リスト（1日分） */
        <div className="rounded-2xl border bg-white shadow-sm overflow-hidden">
          <div className="divide-y divide-gray-100">
            {schedules.map((sched) => {
              const color = getServiceColor(sched.service_type);
              const recorded = hasRecord(sched);
              const ee = getEntryExit(sched);
              return (
                <div key={sched.id} className="px-4 py-3">
                  {/* 基本情報 */}
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-bold text-gray-900 tabular-nums">
                          {sched.start_time.slice(0, 5)}~{sched.end_time.slice(0, 5)}
                        </span>
                        <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", color.bg, color.text, "border", color.border)}>
                          {sched.service_type}
                        </span>
                        {recorded && (
                          <span className="text-[10px] font-bold bg-green-50 text-green-700 border border-green-200 px-1.5 py-0.5 rounded-full">記録済</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 mt-1">
                        <User size={12} className="text-gray-400" />
                        <span className="text-sm text-gray-700">{sched.user_name}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => setRecordFormTarget(sched)}
                      className={cn(
                        "flex items-center gap-1 px-3 py-2 rounded-xl text-xs font-bold active:scale-95 transition-all shrink-0 ml-2",
                        recorded
                          ? "bg-green-50 text-green-700 border border-green-200 active:bg-green-100"
                          : "bg-blue-600 text-white active:bg-blue-700"
                      )}
                    >
                      {recorded ? (<><Edit3 size={12} />編集</>) : (<><ClipboardList size={12} />記録</>)}
                    </button>
                  </div>

                  {/* 入室・退室ボタン */}
                  <div className="flex items-center gap-2 mt-2">
                    {/* 入室 */}
                    {ee.entry ? (
                      <div className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs">
                        <LogIn size={12} />
                        <span className="font-bold">入室</span>
                        <span className="tabular-nums">{format(new Date(ee.entry.time), "HH:mm")}</span>
                        <MapPin size={10} className="ml-0.5" />
                      </div>
                    ) : (
                      <button
                        onClick={() => handleEntry(sched)}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-bold active:bg-emerald-700 active:scale-95 transition-all"
                      >
                        <LogIn size={12} />
                        入室
                      </button>
                    )}

                    {/* 退室 */}
                    {ee.exit ? (
                      <div className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-orange-50 border border-orange-200 text-orange-700 text-xs">
                        <LogOut size={12} />
                        <span className="font-bold">退室</span>
                        <span className="tabular-nums">{format(new Date(ee.exit.time), "HH:mm")}</span>
                        <MapPin size={10} className="ml-0.5" />
                      </div>
                    ) : (
                      <button
                        onClick={() => handleExit(sched)}
                        disabled={!ee.entry}
                        className={cn(
                          "flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold active:scale-95 transition-all",
                          ee.entry
                            ? "bg-orange-500 text-white active:bg-orange-600"
                            : "bg-gray-200 text-gray-400 cursor-not-allowed"
                        )}
                      >
                        <LogOut size={12} />
                        退室
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Care Record Modal */}
      {recordFormTarget && (
        <CareRecordModal
          sched={recordFormTarget}
          staffId={staffId}
          existingRecord={getRecordForSchedule(recordFormTarget)}
          onClose={() => setRecordFormTarget(null)}
          onSaved={refreshRecords}
        />
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
