"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { UserSidebar } from "@/components/users/user-sidebar";
import { toast } from "sonner";
import {
  Plus,
  Trash2,
  Save,
  Loader2,
  CalendarDays,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

// 共通マスタ members の subset。Phase 2-3-8 で kaigo_staff から張替え。
//   kaigo_staff.name_kana → members.furigana
interface KaigoStaff {
  id: string;
  name: string;
  furigana: string | null;
}

interface PatternDay {
  id?: string; // existing DB row id
  tempId: string; // local temp id
  day_of_week: number; // 0=Sun, 6=Sat
  start_time: string;
  end_time: string;
  service_type: string;
  staff_id: string | null;
}

interface VisitPattern {
  id: string; // pattern group id
  tempId: string;
  pattern_name: string;
  days: PatternDay[];
}

const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

const SERVICE_TYPES = [
  "身体介護",
  "生活援助",
  "身体・生活",
  "通院等乗降介助",
  "その他",
];

const SERVICE_TYPE_COLORS: Record<string, string> = {
  身体介護: "bg-blue-50 border-blue-200",
  生活援助: "bg-green-50 border-green-200",
  "身体・生活": "bg-purple-50 border-purple-200",
  通院等乗降介助: "bg-orange-50 border-orange-200",
  その他: "bg-gray-50 border-gray-200",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function genId() {
  return Math.random().toString(36).slice(2);
}

function emptyDay(dow: number): PatternDay {
  return {
    tempId: genId(),
    day_of_week: dow,
    start_time: "09:00",
    end_time: "10:00",
    service_type: "身体介護",
    staff_id: null,
  };
}

function emptyPattern(): VisitPattern {
  return {
    id: "",
    tempId: genId(),
    pattern_name: "新しいパターン",
    days: [],
  };
}

// ─── DayCell ─────────────────────────────────────────────────────────────────

interface DayCellProps {
  dow: number;
  days: PatternDay[];
  staff: KaigoStaff[];
  onAddDay: (dow: number) => void;
  onRemoveDay: (tempId: string) => void;
  onChangeDay: (tempId: string, field: keyof PatternDay, value: string | null) => void;
}

function DayCell({ dow, days, staff, onAddDay, onRemoveDay, onChangeDay }: DayCellProps) {
  const dayEntries = days.filter((d) => d.day_of_week === dow);
  const isSun = dow === 0;
  const isSat = dow === 6;

  return (
    <div className="flex flex-col gap-1 min-h-[80px] min-w-0">
      <div className="flex items-center justify-between mb-0.5">
        <span
          className={cn(
            "text-xs font-bold",
            isSun ? "text-red-500" : isSat ? "text-blue-500" : "text-gray-600"
          )}
        >
          {DOW_LABELS[dow]}
        </span>
        <button
          onClick={() => onAddDay(dow)}
          className="rounded p-0.5 hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors"
          title="追加"
        >
          <Plus size={11} />
        </button>
      </div>
      <div className="space-y-1">
        {dayEntries.map((entry) => {
          const colCls = SERVICE_TYPE_COLORS[entry.service_type] ?? "bg-gray-50 border-gray-200";
          return (
            <div key={entry.tempId} className="relative group min-w-0">
              {/* Delete button - positioned outside the card */}
              <button
                type="button"
                onClick={() => onRemoveDay(entry.tempId)}
                className="absolute -top-1.5 -right-1.5 z-10 w-5 h-5 rounded-full bg-white border border-gray-300 flex items-center justify-center text-gray-400 hover:text-red-500 hover:border-red-400 hover:bg-red-50 transition-colors shadow-sm opacity-0 group-hover:opacity-100"
                title="この枠を削除"
              >
                <X size={10} />
              </button>
              <div className={cn("rounded border p-1 text-[10px] space-y-0.5 overflow-hidden", colCls)}>
                <div className="flex items-center gap-0.5 min-w-0">
                  <input
                    type="time"
                    value={entry.start_time}
                    onChange={(e) => onChangeDay(entry.tempId, "start_time", e.target.value)}
                    className="min-w-0 flex-1 rounded border-0 bg-transparent text-[10px] px-0 focus:outline-none appearance-none [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none"
                  />
                  <span className="text-gray-400 shrink-0">〜</span>
                  <input
                    type="time"
                    value={entry.end_time}
                    onChange={(e) => onChangeDay(entry.tempId, "end_time", e.target.value)}
                    className="min-w-0 flex-1 rounded border-0 bg-transparent text-[10px] px-0 focus:outline-none appearance-none [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none"
                  />
                </div>
                <select
                  value={entry.service_type}
                  onChange={(e) => onChangeDay(entry.tempId, "service_type", e.target.value)}
                  className="w-full max-w-full rounded border-0 bg-transparent text-[10px] focus:outline-none"
                >
                  {SERVICE_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <select
                value={entry.staff_id ?? ""}
                onChange={(e) =>
                  onChangeDay(entry.tempId, "staff_id", e.target.value || null)
                }
                className="w-full max-w-full rounded border-0 bg-transparent text-[10px] focus:outline-none"
              >
                <option value="">担当未設定</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              </div>
            </div>
          );
        })}
        {dayEntries.length === 0 && (
          <div className="text-center text-[10px] text-gray-300 py-2">—</div>
        )}
      </div>
    </div>
  );
}

// ─── PatternCard ─────────────────────────────────────────────────────────────

interface PatternCardProps {
  pattern: VisitPattern;
  staff: KaigoStaff[];
  onChange: (updated: VisitPattern) => void;
  onDelete: () => void;
  saving: boolean;
  onSave: () => void;
}

function PatternCard({ pattern, staff, onChange, onDelete, saving, onSave }: PatternCardProps) {
  const addDay = (dow: number) => {
    onChange({
      ...pattern,
      days: [...pattern.days, emptyDay(dow)],
    });
  };

  const removeDay = (tempId: string) => {
    onChange({
      ...pattern,
      days: pattern.days.filter((d) => d.tempId !== tempId),
    });
  };

  const changeDay = (tempId: string, field: keyof PatternDay, value: string | null) => {
    onChange({
      ...pattern,
      days: pattern.days.map((d) =>
        d.tempId === tempId ? { ...d, [field]: value } : d
      ),
    });
  };

  return (
    <div className="rounded-xl border bg-white shadow-sm">
      {/* Card header */}
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <input
          type="text"
          value={pattern.pattern_name}
          onChange={(e) => onChange({ ...pattern, pattern_name: e.target.value })}
          className="flex-1 rounded border px-2 py-1 text-sm font-medium text-gray-900 focus:border-blue-500 focus:outline-none"
          placeholder="パターン名"
        />
        <button
          onClick={onSave}
          disabled={saving}
          className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
          保存
        </button>
        <button
          onClick={onDelete}
          className="rounded-lg border px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"
        >
          <Trash2 size={11} />
        </button>
      </div>

      {/* 7-column grid */}
      <div className="grid grid-cols-7 gap-2 p-3">
        {Array.from({ length: 7 }, (_, i) => i).map((dow) => (
          <DayCell
            key={dow}
            dow={dow}
            days={pattern.days}
            staff={staff}
            onAddDay={addDay}
            onRemoveDay={removeDay}
            onChangeDay={changeDay}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function PatternsPage() {
  const supabase = createClient();
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [patterns, setPatterns] = useState<VisitPattern[]>([]);
  const [staff, setStaff] = useState<KaigoStaff[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  // Fetch staff list
  useEffect(() => {
    const fetch = async () => {
      const { data } = await supabase
        .from("members")
        .select("id, name, furigana")
        .eq("status", "active")
        .order("furigana", { nullsFirst: false });
      setStaff(data || []);
    };
    fetch();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchPatterns = useCallback(
    async (userId: string) => {
      setLoading(true);
      const { data, error } = await supabase
        .from("kaigo_visit_patterns")
        .select("id, user_id, pattern_name, day_of_week, start_time, end_time, service_type, staff_id")
        .eq("user_id", userId)
        .order("pattern_name");

      if (error) {
        toast.error("パターンの取得に失敗しました");
        setLoading(false);
        return;
      }

      // Group by pattern_name (since each row = one day entry)
      const grouped = new Map<string, VisitPattern>();
      for (const row of data || []) {
        const key = row.pattern_name;
        if (!grouped.has(key)) {
          grouped.set(key, {
            id: key,
            tempId: genId(),
            pattern_name: key,
            days: [],
          });
        }
        grouped.get(key)!.days.push({
          id: row.id,
          tempId: genId(),
          day_of_week: row.day_of_week,
          start_time: row.start_time,
          end_time: row.end_time,
          service_type: row.service_type,
          staff_id: row.staff_id,
        });
      }
      setPatterns([...grouped.values()]);
      setLoading(false);
    },
    [supabase]
  );

  useEffect(() => {
    if (selectedUserId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
      fetchPatterns(selectedUserId);
    } else {
      setPatterns([]);
    }
  }, [selectedUserId, fetchPatterns]);

  const handleChange = (updated: VisitPattern) => {
    setPatterns((prev) => prev.map((p) => (p.tempId === updated.tempId ? updated : p)));
  };

  const handleAddPattern = () => {
    setPatterns((prev) => [...prev, emptyPattern()]);
  };

  const handleDeletePattern = async (pattern: VisitPattern) => {
    if (!selectedUserId) return;
    // Delete all rows for this pattern_name from DB
    if (pattern.days.some((d) => d.id)) {
      const { error } = await supabase
        .from("kaigo_visit_patterns")
        .delete()
        .eq("user_id", selectedUserId)
        .eq("pattern_name", pattern.id); // pattern.id holds original pattern_name
      if (error) {
        toast.error("削除に失敗しました");
        return;
      }
    }
    setPatterns((prev) => prev.filter((p) => p.tempId !== pattern.tempId));
    toast.success("パターンを削除しました");
  };

  const handleSavePattern = async (pattern: VisitPattern) => {
    if (!selectedUserId) return;
    // Validate: all entries must have a staff assigned
    const noStaff = pattern.days.filter((d) => !d.staff_id);
    if (noStaff.length > 0) {
      toast.error("担当者が未設定の曜日があります。全ての曜日に担当者を設定してください。");
      return;
    }
    setSavingId(pattern.tempId);
    try {
      // Delete existing rows for this pattern (by original name if it exists)
      if (pattern.days.some((d) => d.id) || pattern.id) {
        await supabase
          .from("kaigo_visit_patterns")
          .delete()
          .eq("user_id", selectedUserId)
          .eq("pattern_name", pattern.id || pattern.pattern_name);
      }

      // Insert all current day entries
      if (pattern.days.length > 0) {
        const rows = pattern.days.map((d) => ({
          user_id: selectedUserId,
          pattern_name: pattern.pattern_name,
          day_of_week: d.day_of_week,
          start_time: d.start_time,
          end_time: d.end_time,
          service_type: d.service_type,
          staff_id: d.staff_id || null,
        }));
        const { error } = await supabase.from("kaigo_visit_patterns").insert(rows);
        if (error) throw error;
      }

      toast.success("パターンを保存しました");
      // Update local pattern id to the new pattern_name
      setPatterns((prev) =>
        prev.map((p) =>
          p.tempId === pattern.tempId ? { ...p, id: pattern.pattern_name } : p
        )
      );
    } catch (err: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
      toast.error("保存に失敗: " + (err instanceof Error ? err.message : typeof err === 'object' && err !== null && 'message' in err ? (err as any).message : JSON.stringify(err)));
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      {/* Sidebar */}
      <UserSidebar
        selectedUserId={selectedUserId}
        onSelectUser={setSelectedUserId}
      />

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b bg-white px-5 py-3 shrink-0">
          <div className="flex items-center gap-2">
            <CalendarDays className="text-blue-600" size={20} />
            <h1 className="text-lg font-bold text-gray-900">利用者パターン登録</h1>
          </div>
          {selectedUserId && (
            <button
              onClick={handleAddPattern}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
            >
              <Plus size={15} />
              パターン追加
            </button>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {!selectedUserId ? (
            <div className="flex h-full items-center justify-center text-sm text-gray-400">
              <div className="text-center">
                <CalendarDays size={32} className="mx-auto mb-2 text-gray-300" />
                <p>左のサイドバーから利用者を選択してください</p>
              </div>
            </div>
          ) : loading ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 size={24} className="animate-spin text-blue-500" />
            </div>
          ) : patterns.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-sm text-gray-400">
              <CalendarDays size={32} className="mb-2 text-gray-300" />
              <p>パターンがありません</p>
              <button
                onClick={handleAddPattern}
                className="mt-3 flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
              >
                <Plus size={12} />
                パターンを追加
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {patterns.map((pattern) => (
                <PatternCard
                  key={pattern.tempId}
                  pattern={pattern}
                  staff={staff}
                  onChange={handleChange}
                  onDelete={() => handleDeletePattern(pattern)}
                  saving={savingId === pattern.tempId}
                  onSave={() => handleSavePattern(pattern)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
