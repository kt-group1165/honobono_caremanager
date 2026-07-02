"use client";

import { useState, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
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
import { ServiceSelector } from "@/components/services/service-selector";
// 型 + helper は 「use client 越境で undefined」罠 (memory: feedback_use_client_const_export.md)
// を避けるため patterns-shared.ts に切り出し済。ここでは re-export のみ。
import {
  rowsToPatterns,
  type KaigoStaff,
  type PatternDay,
  type VisitPattern,
  type VisitPatternRow,
} from "./patterns-shared";
export { rowsToPatterns };
export type { KaigoStaff, PatternDay, VisitPattern, VisitPatternRow };

const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

// サービスコードの正式名称 (身体介護3 等) から色分けを推定
function serviceColorClass(t: string): string {
  if (!t) return "bg-gray-50 border-gray-200";
  const body = /身体|身\d/.test(t);
  const life = /生活|生\d/.test(t);
  if (t.includes("乗降")) return "bg-orange-50 border-orange-200";
  if (body && life) return "bg-purple-50 border-purple-200";
  if (body) return "bg-blue-50 border-blue-200";
  if (life) return "bg-green-50 border-green-200";
  return "bg-gray-50 border-gray-200";
}

function genId() {
  return Math.random().toString(36).slice(2);
}

// rowsToPatterns は patterns-shared.ts に移動済 (server component から安全に import 可)

function emptyDay(dow: number): PatternDay {
  return {
    tempId: genId(),
    day_of_week: dow,
    start_time: "09:00",
    end_time: "10:00",
    service_type: "", // ServiceSelector でコードマスタから選択させる
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
  // ServiceSelector を開いている entry の tempId
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const pickerTarget = pickerFor ? dayEntries.find((d) => d.tempId === pickerFor) : undefined;

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
          const colCls = serviceColorClass(entry.service_type);
          return (
            <div key={entry.tempId} className="relative group min-w-0">
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
                <button
                  type="button"
                  onClick={() => setPickerFor(entry.tempId)}
                  className="block w-full max-w-full truncate rounded border-0 bg-transparent text-left text-[10px] hover:underline focus:outline-none"
                  title={entry.service_type || "サービスを選択"}
                >
                  {entry.service_type || <span className="text-red-500 font-medium">サービス選択</span>}
                </button>
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

      {/* サービスコードマスタからの選択ダイアログ (時間枠に合う候補を優先表示) */}
      {pickerTarget && (
        <ServiceSelector
          open
          onClose={() => setPickerFor(null)}
          startTime={pickerTarget.start_time}
          endTime={pickerTarget.end_time}
          onSelect={(svc) => {
            onChangeDay(pickerTarget.tempId, "service_type", svc.name);
            setPickerFor(null);
          }}
        />
      )}
    </div>
  );
}

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

export interface PatternsContentProps {
  userId: string;
  initialPatterns: VisitPattern[];
  initialStaff: KaigoStaff[];
}

export function PatternsContent({ userId, initialPatterns, initialStaff }: PatternsContentProps) {
  const supabase = useMemo(() => createClient(), []);
  const [patterns, setPatterns] = useState<VisitPattern[]>(initialPatterns);
  const [staff] = useState<KaigoStaff[]>(initialStaff);
  const [savingId, setSavingId] = useState<string | null>(null);

  const handleChange = (updated: VisitPattern) => {
    setPatterns((prev) => prev.map((p) => (p.tempId === updated.tempId ? updated : p)));
  };

  const handleAddPattern = () => {
    setPatterns((prev) => [...prev, emptyPattern()]);
  };

  const handleDeletePattern = async (pattern: VisitPattern) => {
    if (pattern.days.some((d) => d.id)) {
      const { error } = await supabase
        .from("kaigo_visit_patterns")
        .delete()
        .eq("user_id", userId)
        .eq("pattern_name", pattern.id);
      if (error) {
        toast.error("削除に失敗しました");
        return;
      }
    }
    setPatterns((prev) => prev.filter((p) => p.tempId !== pattern.tempId));
    toast.success("パターンを削除しました");
  };

  const handleSavePattern = async (pattern: VisitPattern) => {
    if (pattern.days.some((d) => !d.service_type)) {
      toast.error("サービス未選択の枠があります。全ての枠でサービスを選択してください。");
      return;
    }
    const noStaff = pattern.days.filter((d) => !d.staff_id);
    if (noStaff.length > 0) {
      toast.error("担当者が未設定の曜日があります。全ての曜日に担当者を設定してください。");
      return;
    }
    setSavingId(pattern.tempId);
    try {
      if (pattern.days.some((d) => d.id) || pattern.id) {
        await supabase
          .from("kaigo_visit_patterns")
          .delete()
          .eq("user_id", userId)
          .eq("pattern_name", pattern.id || pattern.pattern_name);
      }

      if (pattern.days.length > 0) {
        const rows = pattern.days.map((d) => ({
          user_id: userId,
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
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b bg-white px-5 py-3 shrink-0">
        <div className="flex items-center gap-2">
          <CalendarDays className="text-blue-600" size={20} />
          <h1 className="text-lg font-bold text-gray-900">利用者パターン登録</h1>
        </div>
        <button
          onClick={handleAddPattern}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
        >
          <Plus size={15} />
          パターン追加
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {patterns.length === 0 ? (
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
  );
}
