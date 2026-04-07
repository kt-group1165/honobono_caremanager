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

const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

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

// ─── Base Settings Tab ────────────────────────────────────────────────────────

interface BaseSettingsTabProps {
  staffId: string;
}

function BaseSettingsTab({ staffId }: BaseSettingsTabProps) {
  const supabase = createAnonClient();
  const [slots, setSlots] = useState<BaseSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const fetch = async () => {
      setLoading(true);
      const { data } = await supabase
        .from("kaigo_staff_availability_base")
        .select("id, staff_id, day_of_week, start_time, end_time")
        .eq("staff_id", staffId)
        .order("day_of_week")
        .order("start_time");

      if (data && data.length > 0) {
        const mapped: BaseSlot[] = data.map((r: any) => ({
          id: r.id,
          tempId: genId(),
          day_of_week: r.day_of_week,
          start_time: r.start_time,
          end_time: r.end_time,
        }));
        setSlots(mapped);
      } else {
        // Default: Mon-Fri 9:00-18:00
        const defaults: BaseSlot[] = [1, 2, 3, 4, 5].map((dow) => ({
          tempId: genId(),
          day_of_week: dow,
          start_time: "09:00",
          end_time: "18:00",
        }));
        setSlots(defaults);
      }
      setLoading(false);
    };
    fetch();
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
      // Delete all existing base slots for this staff
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
      toast.error("保存に失敗しました: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  const slotsForDow = (dow: number) => slots.filter((s) => s.day_of_week === dow);

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 size={24} className="animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600">
        週間の勤務可能時間帯を設定してください。月別設定の「ベースから取り込み」で各月のカレンダーに反映されます。
      </p>

      {/* 7-column grid */}
      <div className="grid grid-cols-7 gap-2">
        {Array.from({ length: 7 }, (_, i) => i).map((dow) => {
          const isSun = dow === 0;
          const isSat = dow === 6;
          const daySlots = slotsForDow(dow);
          return (
            <div key={dow} className="flex flex-col gap-1">
              <div className="flex items-center justify-between mb-1">
                <span
                  className={cn(
                    "text-sm font-bold",
                    isSun ? "text-red-500" : isSat ? "text-blue-500" : "text-gray-700"
                  )}
                >
                  {DOW_LABELS[dow]}
                </span>
                <button
                  onClick={() => addSlot(dow)}
                  className="rounded p-0.5 hover:bg-gray-100 text-gray-400 hover:text-gray-700"
                  title="追加"
                >
                  <Plus size={12} />
                </button>
              </div>
              <div className="space-y-1">
                {daySlots.map((slot) => (
                  <div
                    key={slot.tempId}
                    className="rounded-lg border p-2 text-xs space-y-1 bg-white border-gray-200"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-green-600 font-medium">対応可</span>
                      <button
                        onClick={() => removeSlot(slot.tempId)}
                        className="text-gray-300 hover:text-red-400 transition-colors"
                      >
                        <X size={10} />
                      </button>
                    </div>
                    <input
                      type="time"
                      value={slot.start_time}
                      onChange={(e) =>
                        changeSlot(slot.tempId, "start_time", e.target.value)
                      }
                      className="w-full rounded border px-1 py-0.5 text-[11px] focus:border-blue-500 focus:outline-none"
                    />
                    <span className="block text-center text-[10px] text-gray-400">〜</span>
                    <input
                      type="time"
                      value={slot.end_time}
                      onChange={(e) =>
                        changeSlot(slot.tempId, "end_time", e.target.value)
                      }
                      className="w-full rounded border px-1 py-0.5 text-[11px] focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                ))}
                {daySlots.length === 0 && (
                  <div
                    className="rounded-lg border border-dashed border-gray-200 p-2 text-center text-[10px] text-gray-300 cursor-pointer hover:border-gray-300 hover:text-gray-400"
                    onClick={() => addSlot(dow)}
                  >
                    対応不可
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
          ベース設定を保存
        </button>
      </div>
    </div>
  );
}

// ─── Monthly Settings Tab ──────────────────────────────────────────────────────

interface MonthlySettingsTabProps {
  staffId: string;
}

function MonthlySettingsTab({ staffId }: MonthlySettingsTabProps) {
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
        .select("id, staff_id, available_date, start_time, end_time, is_available")
        .eq("staff_id", staffId)
        .gte("available_date", from)
        .lte("available_date", to)
        .order("available_date")
        .order("start_time");

      const mapped: MonthlySlot[] = (data || []).map((r: any) => ({
        id: r.id,
        tempId: genId(),
        available_date: r.available_date,
        start_time: r.start_time,
        end_time: r.end_time,
        is_available: r.is_available,
      }));
      setMonthlySlots(mapped);
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
      // Fetch base slots
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

      // Delete existing monthly slots for this month
      await supabase
        .from("kaigo_staff_availability_monthly")
        .delete()
        .eq("staff_id", staffId)
        .gte("available_date", from)
        .lte("available_date", to);

      // Generate rows for each day in the month
      const rows: Record<string, unknown>[] = [];
      for (const day of days) {
        const dow = getDay(day);
        const matchingBase = base.filter((b: any) => b.day_of_week === dow);
        if (matchingBase.length === 0) {
          // No base slot for this DoW → mark as unavailable
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
      toast.error("取り込みに失敗しました: " + (err instanceof Error ? err.message : String(err)));
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

  const changeSlot = (tempId: string, field: keyof MonthlySlot, value: string | boolean) => {
    setMonthlySlots((prev) =>
      prev.map((s) => (s.tempId === tempId ? { ...s, [field]: value } : s))
    );
  };

  const handleSaveMonth = async () => {
    setSaving(true);
    try {
      const from = format(startOfMonth(currentMonth), "yyyy-MM-dd");
      const to = format(endOfMonth(currentMonth), "yyyy-MM-dd");

      // Delete all existing
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
      // Refresh
      await fetchMonthly(currentMonth);
    } catch (err: unknown) {
      toast.error("保存に失敗しました: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  const slotsForDate = (dateStr: string) =>
    monthlySlots.filter((s) => s.available_date === dateStr);

  const isDayUnavailable = (dateStr: string) => {
    const slots = slotsForDate(dateStr);
    if (slots.length === 0) return true;
    return slots.every((s) => !s.is_available);
  };

  const firstDow = days.length > 0 ? getDay(days[0]) : 0;

  return (
    <div className="space-y-4">
      {/* Month nav + import */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
            className="rounded border p-1.5 hover:bg-gray-50"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="min-w-[7rem] text-center text-sm font-semibold text-gray-900">
            {format(currentMonth, "yyyy年M月", { locale: ja })}
          </span>
          <button
            onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
            className="rounded border p-1.5 hover:bg-gray-50"
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={importFromBase}
            disabled={importing}
            className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            {importing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            ベースから取り込み
          </button>
          <button
            onClick={handleSaveMonth}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            月別設定を保存
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 size={24} className="animate-spin text-blue-500" />
        </div>
      ) : (
        <div className="grid grid-cols-7 gap-1.5">
          {/* DoW header */}
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
          {/* Leading blanks */}
          {Array.from({ length: firstDow }).map((_, i) => (
            <div key={`blank-${i}`} className="rounded bg-gray-50 min-h-[100px]" />
          ))}
          {/* Day cells */}
          {days.map((day) => {
            const dateStr = format(day, "yyyy-MM-dd");
            const dow = getDay(day);
            const isToday = isSameDay(day, new Date());
            const unavail = isDayUnavailable(dateStr);
            const isSelected = selectedDate === dateStr;
            const daySlots = slotsForDate(dateStr);

            return (
              <div
                key={dateStr}
                onClick={() => setSelectedDate(isSelected ? null : dateStr)}
                className={cn(
                  "rounded border min-h-[100px] p-1 cursor-pointer transition-colors",
                  isSelected
                    ? "border-blue-400 bg-blue-50"
                    : unavail
                    ? "bg-gray-200 border-gray-300"
                    : dow === 0
                    ? "bg-red-50/40 border-red-100"
                    : dow === 6
                    ? "bg-blue-50/40 border-blue-100"
                    : "bg-white border-gray-100 hover:bg-gray-50"
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
                      : unavail
                      ? "text-gray-400"
                      : "text-gray-700"
                  )}
                >
                  {format(day, "d")}
                </span>
                {unavail && daySlots.length === 0 && (
                  <div className="text-[9px] text-gray-400 text-center mt-1">対応不可</div>
                )}
                <div className="space-y-0.5 mt-0.5">
                  {daySlots.filter(s => s.is_available).map((slot) => (
                    <div
                      key={slot.tempId}
                      className="rounded bg-green-100 px-1 py-0.5 text-[10px] text-green-700 leading-tight"
                    >
                      {slot.start_time.slice(0, 5)}〜{slot.end_time.slice(0, 5)}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Selected day edit panel */}
      {selectedDate && (
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-900">
              {format(new Date(selectedDate + "T00:00:00"), "M月d日(E)", { locale: ja })} の設定
            </h3>
            <div className="flex items-center gap-2">
              <button
                onClick={() => addSlotToDate(selectedDate)}
                className="flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700"
              >
                <Plus size={10} />
                時間帯追加
              </button>
              <button
                onClick={() => setSelectedDate(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {slotsForDate(selectedDate).length === 0 ? (
            <div className="text-center text-sm text-gray-400 py-4">
              <p>この日は対応不可（スロットなし）</p>
              <button
                onClick={() => addSlotToDate(selectedDate)}
                className="mt-2 text-xs text-blue-500 underline"
              >
                時間帯を追加して対応可にする
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {slotsForDate(selectedDate).map((slot) => (
                <div
                  key={slot.tempId}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border p-2 text-sm",
                    slot.is_available ? "bg-white" : "bg-gray-50"
                  )}
                >
                  <label className="flex items-center gap-1 text-xs cursor-pointer whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={slot.is_available}
                      onChange={(e) => changeSlot(slot.tempId, "is_available", e.target.checked)}
                      className="rounded"
                    />
                    対応可
                  </label>
                  <input
                    type="time"
                    value={slot.start_time}
                    onChange={(e) => changeSlot(slot.tempId, "start_time", e.target.value)}
                    disabled={!slot.is_available}
                    className="rounded border px-2 py-1 text-xs focus:border-blue-500 focus:outline-none disabled:opacity-40"
                  />
                  <span className="text-gray-400 text-xs">〜</span>
                  <input
                    type="time"
                    value={slot.end_time}
                    onChange={(e) => changeSlot(slot.tempId, "end_time", e.target.value)}
                    disabled={!slot.is_available}
                    className="rounded border px-2 py-1 text-xs focus:border-blue-500 focus:outline-none disabled:opacity-40"
                  />
                  <button
                    onClick={() => removeSlot(slot.tempId)}
                    className="ml-auto text-gray-300 hover:text-red-400 transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type Params = { token: string };

export default function StaffAvailabilityPage({ params }: { params: Promise<Params> }) {
  const { token } = use(params);
  const supabase = createAnonClient();
  const [staff, setStaff] = useState<StaffInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [invalid, setInvalid] = useState(false);
  const [activeTab, setActiveTab] = useState<"base" | "monthly">("base");

  useEffect(() => {
    const fetch = async () => {
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
    fetch();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <Loader2 size={32} className="animate-spin text-blue-500" />
      </div>
    );
  }

  if (invalid || !staff) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
        <div className="max-w-sm w-full text-center">
          <AlertCircle size={48} className="mx-auto mb-4 text-red-400" />
          <h1 className="text-xl font-bold text-gray-900 mb-2">無効なURL</h1>
          <p className="text-sm text-gray-500">
            このURLは無効か期限切れです。管理者にご連絡ください。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b shadow-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex items-center gap-3">
            <CalendarDays className="text-blue-600" size={24} />
            <div>
              <h1 className="text-lg font-bold text-gray-900">勤務可能時間申告</h1>
              <p className="text-xs text-gray-500">{staff.name}（{staff.name_kana}）</p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-6">
        {/* Tabs */}
        <div className="flex border-b mb-6">
          <button
            onClick={() => setActiveTab("base")}
            className={cn(
              "px-5 py-2.5 text-sm font-medium border-b-2 transition-colors",
              activeTab === "base"
                ? "border-blue-600 text-blue-700"
                : "border-transparent text-gray-500 hover:text-gray-700"
            )}
          >
            ベース設定
          </button>
          <button
            onClick={() => setActiveTab("monthly")}
            className={cn(
              "px-5 py-2.5 text-sm font-medium border-b-2 transition-colors",
              activeTab === "monthly"
                ? "border-blue-600 text-blue-700"
                : "border-transparent text-gray-500 hover:text-gray-700"
            )}
          >
            月別設定
          </button>
        </div>

        {/* Tab content */}
        <div className="bg-white rounded-xl border shadow-sm p-5">
          {activeTab === "base" ? (
            <BaseSettingsTab staffId={staff.id} />
          ) : (
            <MonthlySettingsTab staffId={staff.id} />
          )}
        </div>
      </div>
    </div>
  );
}
