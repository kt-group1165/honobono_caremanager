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
  CalendarPlus,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ServiceSelector } from "@/components/services/service-selector";
import { useBusinessType } from "@/lib/business-type-context";
import { insertVisitSchedules } from "../_shared";
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

// TIME 値 (HH:MM もしくは HH:MM:SS) を Postgres TIME 用に HH:MM:SS へ正規化。
// 保存済パターンは DB から HH:MM:SS で来るが、未保存の枠は HH:MM なので揃える。
function normalizeTime(t: string): string {
  const parts = t.split(":");
  const hh = (parts[0] ?? "00").padStart(2, "0");
  const mm = (parts[1] ?? "00").padStart(2, "0");
  const ss = (parts[2] ?? "00").padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// 指定年月 (year, month は 1〜12) の中で day_of_week (0=日〜6=土) に該当する
// 全日付を "YYYY-MM-DD" で返す。
function datesForDow(year: number, month: number, dow: number): string[] {
  const out: string[] = [];
  // month は 1-based → Date は 0-based
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month - 1, day);
    if (d.getDay() === dow) {
      const mm = String(month).padStart(2, "0");
      const dd = String(day).padStart(2, "0");
      out.push(`${year}-${mm}-${dd}`);
    }
  }
  return out;
}

function defaultMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
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
  const { currentOfficeId } = useBusinessType();
  const [patterns, setPatterns] = useState<VisitPattern[]>(initialPatterns);
  const [staff] = useState<KaigoStaff[]>(initialStaff);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [expandMonth, setExpandMonth] = useState<string>(defaultMonth());
  const [expanding, setExpanding] = useState(false);

  // 週間パターンを対象年月の該当曜日すべてに kaigo_visit_schedule として展開 (ほのぼの相当)。
  // 重複防止キー = user_id + visit_date + start_time + service_type。
  const handleExpand = async () => {
    // 保存済 (DB にある) パターンのみ展開対象。未保存の days は id を持たない。
    const savedDays = patterns.flatMap((p) => p.days.filter((d) => d.id));
    if (savedDays.length === 0) {
      toast.error("展開できる保存済パターンがありません。先にパターンを保存してください。");
      return;
    }
    const m = /^(\d{4})-(\d{2})$/.exec(expandMonth);
    if (!m) {
      toast.error("対象年月が不正です");
      return;
    }
    const year = Number(m[1]);
    const month = Number(m[2]);

    // パターン → その月の日付集合へ展開して候補行を作る
    const candidates = savedDays.flatMap((d) =>
      datesForDow(year, month, d.day_of_week).map((visit_date) => ({
        user_id: userId,
        staff_id: d.staff_id || null,
        visit_date,
        start_time: normalizeTime(d.start_time),
        end_time: normalizeTime(d.end_time),
        service_type: d.service_type,
        status: "scheduled" as const,
      }))
    );
    if (candidates.length === 0) {
      toast.error("該当する曜日がこの月にありません");
      return;
    }

    setExpanding(true);
    try {
      // 既存予定を取得して重複判定 (user_id + visit_date + start_time + service_type)
      const from = `${year}-${String(month).padStart(2, "0")}-01`;
      const to = `${year}-${String(month).padStart(2, "0")}-${String(
        new Date(year, month, 0).getDate()
      ).padStart(2, "0")}`;
      const { data: existing, error: exErr } = await supabase
        .from("kaigo_visit_schedule")
        .select("visit_date, start_time, service_type")
        .eq("user_id", userId)
        .gte("visit_date", from)
        .lte("visit_date", to);
      if (exErr) throw exErr;

      const existingRows = (existing ?? []) as {
        visit_date: string;
        start_time: string;
        service_type: string;
      }[];
      const existingKeys = new Set(
        existingRows.map(
          (r) => `${r.visit_date}|${normalizeTime(r.start_time)}|${r.service_type}`
        )
      );

      // 候補内での自己重複も排除しつつ、既存と衝突しない行だけ残す
      const seen = new Set<string>(existingKeys);
      const toInsert: typeof candidates = [];
      let skipped = 0;
      for (const c of candidates) {
        const key = `${c.visit_date}|${c.start_time}|${c.service_type}`;
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        seen.add(key);
        toInsert.push(c);
      }

      if (toInsert.length === 0) {
        toast.info(`作成対象なし (${skipped} 件は既存でスキップ)`);
        return;
      }
      if (
        !window.confirm(
          `${expandMonth} に ${toInsert.length} 件の予定を作成します。` +
            (skipped > 0 ? ` (既存 ${skipped} 件はスキップ)` : "") +
            "\nよろしいですか？"
        )
      ) {
        return;
      }

      // C5: 発生元 office を付与 (列未適用 42703/PGRST204 は helper が strip して retry)
      const insertRows = toInsert.map((c) => ({
        ...c,
        ...(currentOfficeId ? { office_id: currentOfficeId } : {}),
      }));
      const { error: insErr } = await insertVisitSchedules(supabase, insertRows);
      if (insErr) throw insErr;

      toast.success(
        `${toInsert.length} 件の予定を作成しました` +
          (skipped > 0 ? ` (${skipped} 件スキップ)` : "")
      );
    } catch (err: unknown) {
      toast.error(
        "展開に失敗: " + (err instanceof Error ? err.message : JSON.stringify(err))
      );
    } finally {
      setExpanding(false);
    }
  };

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
        const { error: delError } = await supabase
          .from("kaigo_visit_patterns")
          .delete()
          .eq("user_id", userId)
          .eq("pattern_name", pattern.id || pattern.pattern_name);
        if (delError) throw delError;
      }

      let daysWithIds = pattern.days;
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
        const { data: inserted, error } = await supabase
          .from("kaigo_visit_patterns")
          .insert(rows)
          .select("id");
        if (error) throw error;
        // INSERT の返却 id を days に反映する。これが無いと「月間へ展開」の
        // 保存済み判定 (d.id) がリロードまで false のままになる
        const ids = ((inserted ?? []) as { id: string }[]).map((r) => r.id);
        daysWithIds = pattern.days.map((d, i) => ({ ...d, id: ids[i] ?? d.id }));
      }

      toast.success("パターンを保存しました");
      setPatterns((prev) =>
        prev.map((p) =>
          p.tempId === pattern.tempId
            ? { ...p, id: pattern.pattern_name, days: daysWithIds }
            : p
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
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-lg border bg-gray-50 px-2 py-1">
            <input
              type="month"
              value={expandMonth}
              onChange={(e) => setExpandMonth(e.target.value)}
              className="rounded border-0 bg-transparent text-sm text-gray-800 focus:outline-none"
              aria-label="展開対象年月"
            />
            <button
              onClick={handleExpand}
              disabled={expanding}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
              title="週間パターンをこの月の該当曜日すべてに予定として展開"
            >
              {expanding ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <CalendarPlus size={15} />
              )}
              この月にパターンを適用
            </button>
          </div>
          <button
            onClick={handleAddPattern}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            <Plus size={15} />
            パターン追加
          </button>
        </div>
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
