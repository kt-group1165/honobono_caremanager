"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Save,
  Loader2,
} from "lucide-react";
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  addMonths,
  subMonths,
  getDay,
} from "date-fns";
import { ja } from "date-fns/locale";

type ShiftType = "早番" | "日勤" | "遅番" | "夜勤" | "休み" | "有給" | "公休" | "";

// 共通マスタ members の subset。Phase 2-3-8 で kaigo_staff から張替え。
//   kaigo_staff.name_kana → members.furigana
interface Staff {
  id: string;
  name: string;
  furigana: string | null;
}

interface ShiftRecord {
  id?: string;
  staff_id: string;
  shift_date: string;
  shift_type: ShiftType;
}

type ShiftMap = Record<string, Record<string, ShiftType>>;

const SHIFT_TYPES: ShiftType[] = ["早番", "日勤", "遅番", "夜勤", "休み", "有給", "公休", ""];

const SHIFT_COLORS: Record<string, string> = {
  早番: "bg-yellow-100 text-yellow-800 border-yellow-200",
  日勤: "bg-blue-100 text-blue-800 border-blue-200",
  遅番: "bg-orange-100 text-orange-800 border-orange-200",
  夜勤: "bg-purple-100 text-purple-800 border-purple-200",
  休み: "bg-gray-100 text-gray-500 border-gray-200",
  有給: "bg-green-100 text-green-800 border-green-200",
  公休: "bg-gray-100 text-gray-500 border-gray-200",
  "": "bg-white text-gray-300 border-gray-100",
};

const DAY_OF_WEEK_JA = ["日", "月", "火", "水", "木", "金", "土"];

export default function ShiftsPage() {
  const supabase = createClient();
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [staff, setStaff] = useState<Staff[]>([]);
  const [shiftMap, setShiftMap] = useState<ShiftMap>({});
  const [changes, setChanges] = useState<ShiftMap>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [openDropdown, setOpenDropdown] = useState<{ staffId: string; date: string } | null>(null);

  const days = eachDayOfInterval({
    start: startOfMonth(currentMonth),
    end: endOfMonth(currentMonth),
  });

  const fetchData = useCallback(async () => {
    setLoading(true);
    setChanges({});

    const monthStart = format(startOfMonth(currentMonth), "yyyy-MM-dd");
    const monthEnd = format(endOfMonth(currentMonth), "yyyy-MM-dd");

    const [staffRes, shiftsRes] = await Promise.all([
      supabase
        .from("members")
        .select("id, name, furigana")
        .eq("status", "active")
        .order("furigana", { nullsFirst: false }),
      supabase
        .from("kaigo_shifts")
        .select("*")
        .gte("shift_date", monthStart)
        .lte("shift_date", monthEnd),
    ]);

    if (staffRes.error) {
      toast.error("職員データの取得に失敗しました");
    } else {
      setStaff(staffRes.data || []);
    }

    if (shiftsRes.error) {
      toast.error("シフトデータの取得に失敗しました");
    } else {
      const map: ShiftMap = {};
      for (const shift of shiftsRes.data || []) {
        if (!map[shift.staff_id]) map[shift.staff_id] = {};
        map[shift.staff_id][shift.shift_date] = shift.shift_type;
      }
      setShiftMap(map);
    }

    setLoading(false);
  }, [currentMonth, supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    fetchData();
  }, [fetchData]);

  const getShift = (staffId: string, date: string): ShiftType => {
    if (changes[staffId]?.[date] !== undefined) return changes[staffId][date];
    return shiftMap[staffId]?.[date] ?? "";
  };

  const cycleShift = (staffId: string, date: string) => {
    const current = getShift(staffId, date);
    const idx = SHIFT_TYPES.indexOf(current);
    const next = SHIFT_TYPES[(idx + 1) % SHIFT_TYPES.length];
    setChanges((prev) => ({
      ...prev,
      [staffId]: { ...(prev[staffId] || {}), [date]: next },
    }));
    setOpenDropdown(null);
  };

  const setShift = (staffId: string, date: string, type: ShiftType) => {
    setChanges((prev) => ({
      ...prev,
      [staffId]: { ...(prev[staffId] || {}), [date]: type },
    }));
    setOpenDropdown(null);
  };

  const hasChanges = Object.keys(changes).length > 0;

  const handleSave = async () => {
    setSaving(true);
    try {
      const upserts: ShiftRecord[] = [];
      for (const [staffId, dates] of Object.entries(changes)) {
        for (const [date, type] of Object.entries(dates)) {
          upserts.push({ staff_id: staffId, shift_date: date, shift_type: type as ShiftType });
        }
      }

      if (upserts.length > 0) {
        const { error } = await supabase
          .from("kaigo_shifts")
          .upsert(upserts, { onConflict: "staff_id,shift_date" });
        if (error) throw error;
      }

      toast.success(`${upserts.length}件のシフトを保存しました`);
      setChanges({});
      fetchData();
    } catch (err: unknown) {
      toast.error(
        "保存に失敗しました: " + (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setSaving(false);
    }
  };

  const prevMonth = () => setCurrentMonth(subMonths(currentMonth, 1));
  const nextMonth = () => setCurrentMonth(addMonths(currentMonth, 1));

  const totalChanges = Object.values(changes).reduce(
    (acc, dates) => acc + Object.keys(dates).length,
    0
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarDays className="text-blue-600" size={24} />
          <h1 className="text-xl font-bold text-gray-900">シフト管理</h1>
        </div>
        <div className="flex items-center gap-3">
          {hasChanges && (
            <span className="text-sm text-orange-600 font-medium">
              {totalChanges}件の未保存の変更があります
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40 transition-colors"
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
            保存する
          </button>
        </div>
      </div>

      {/* Month Navigation */}
      <div className="flex items-center gap-4">
        <button
          onClick={prevMonth}
          className="rounded-lg border p-2 hover:bg-gray-50 transition-colors"
        >
          <ChevronLeft size={18} />
        </button>
        <h2 className="text-lg font-semibold text-gray-900 min-w-[140px] text-center">
          {format(currentMonth, "yyyy年M月", { locale: ja })}
        </h2>
        <button
          onClick={nextMonth}
          className="rounded-lg border p-2 hover:bg-gray-50 transition-colors"
        >
          <ChevronRight size={18} />
        </button>
        <div className="flex items-center gap-2 ml-4 flex-wrap">
          {(Object.entries(SHIFT_COLORS) as [ShiftType | string, string][])
            .filter(([k]) => k !== "")
            .map(([type, cls]) => (
              <span
                key={type}
                className={`rounded border px-2 py-0.5 text-xs font-medium ${cls}`}
              >
                {type}
              </span>
            ))}
        </div>
      </div>

      {/* Grid */}
      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 size={28} className="animate-spin text-blue-500" />
        </div>
      ) : staff.length === 0 ? (
        <div className="rounded-lg border bg-white py-16 text-center text-sm text-gray-500">
          在職中の職員がいません
        </div>
      ) : (
        <div
          className="overflow-auto rounded-lg border bg-white shadow-sm"
          onClick={() => setOpenDropdown(null)}
        >
          <table className="text-xs border-collapse">
            <thead>
              <tr className="bg-gray-50">
                <th className="sticky left-0 z-20 bg-gray-50 border-b border-r px-3 py-2 text-left font-medium text-gray-600 min-w-[120px] whitespace-nowrap">
                  職員名
                </th>
                {days.map((day) => {
                  const dow = getDay(day);
                  const isSun = dow === 0;
                  const isSat = dow === 6;
                  return (
                    <th
                      key={day.toISOString()}
                      className={`border-b border-r px-1 py-1 text-center font-medium min-w-[48px] ${
                        isSun ? "text-red-500 bg-red-50" : isSat ? "text-blue-500 bg-blue-50" : "text-gray-600"
                      }`}
                    >
                      <div>{format(day, "d")}</div>
                      <div className="text-[10px] opacity-70">{DAY_OF_WEEK_JA[dow]}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {staff.map((member) => (
                <tr key={member.id} className="hover:bg-gray-50/50">
                  <td className="sticky left-0 z-10 bg-white border-b border-r px-3 py-1 font-medium text-gray-800 whitespace-nowrap">
                    {member.name}
                  </td>
                  {days.map((day) => {
                    const dateStr = format(day, "yyyy-MM-dd");
                    const shiftType = getShift(member.id, dateStr);
                    const isChanged =
                      changes[member.id]?.[dateStr] !== undefined;
                    const isOpen =
                      openDropdown?.staffId === member.id &&
                      openDropdown?.date === dateStr;
                    const dow = getDay(day);

                    return (
                      <td
                        key={dateStr}
                        className={`border-b border-r p-0.5 text-center relative ${
                          dow === 0 ? "bg-red-50/30" : dow === 6 ? "bg-blue-50/30" : ""
                        }`}
                      >
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenDropdown(isOpen ? null : { staffId: member.id, date: dateStr });
                          }}
                          className={`w-full rounded border text-[11px] font-medium px-1 py-0.5 transition-all ${
                            SHIFT_COLORS[shiftType] || SHIFT_COLORS[""]
                          } ${isChanged ? "ring-1 ring-orange-400" : ""} hover:opacity-80`}
                          title={`${member.name} - ${dateStr}: ${shiftType || "未設定"}`}
                        >
                          {shiftType || "　"}
                        </button>
                        {isOpen && (
                          <div
                            className="absolute z-30 top-full left-0 mt-0.5 bg-white border rounded-lg shadow-lg p-1 min-w-[80px]"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {SHIFT_TYPES.map((type) => (
                              <button
                                key={type === "" ? "__empty__" : type}
                                onClick={() => setShift(member.id, dateStr, type)}
                                className={`block w-full text-left rounded px-2 py-1 text-xs font-medium hover:opacity-80 transition-colors ${
                                  SHIFT_COLORS[type] || SHIFT_COLORS[""]
                                } ${shiftType === type ? "ring-1 ring-blue-400" : ""}`}
                              >
                                {type || "—"}
                              </button>
                            ))}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Summary row */}
      {!loading && staff.length > 0 && (
        <div className="rounded-lg border bg-gray-50 px-4 py-3">
          <div className="flex items-center gap-6 text-sm text-gray-600">
            <span className="font-medium">月集計</span>
            {(["早番", "日勤", "遅番", "夜勤", "休み", "有給", "公休"] as ShiftType[]).map((type) => {
              const count = staff.reduce((acc, member) => {
                return (
                  acc +
                  days.filter(
                    (day) => getShift(member.id, format(day, "yyyy-MM-dd")) === type
                  ).length
                );
              }, 0);
              return (
                <span key={type} className="flex items-center gap-1">
                  <span
                    className={`rounded border px-1.5 py-0.5 text-xs font-medium ${SHIFT_COLORS[type]}`}
                  >
                    {type}
                  </span>
                  <span className="font-medium">{count}</span>
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
