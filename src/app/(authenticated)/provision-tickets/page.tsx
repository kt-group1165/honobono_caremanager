"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { UserSidebar } from "@/components/users/user-sidebar";
import {
  FileText,
  Loader2,
  Save,
  Printer,
  ChevronLeft,
  ChevronRight,
  Plus,
  X,
  Edit3,
  Check,
  Clock as ClockIcon,
  AlertTriangle,
} from "lucide-react";
import {
  format,
  getDaysInMonth,
  addMonths,
  subMonths,
} from "date-fns";
import { ja } from "date-fns/locale";
import { cn } from "@/lib/utils";
import { ServiceSelector } from "@/components/services/service-selector";

// ─── Types ────────────────────────────────────────────────────────────────────

interface KaigoUser {
  id: string;
  name: string;
  name_kana: string | null;
  care_level?: string | null;
  insurer_no?: string | null;
  insured_no?: string | null;
}

interface KaigoStaff {
  id: string;
  name: string;
}

interface KaigoProvider {
  id: string;
  provider_name: string;
}

interface VisitSchedule {
  id: string;
  user_id: string;
  staff_id: string | null;
  visit_date: string;
  start_time: string;
  end_time: string;
  service_type: string;
  status: string;
  staff_name?: string | null;
}

// A "row" in the provision ticket grid = unique combination of service + time + provider
interface ServiceRow {
  key: string; // e.g. "身体介護1__09:00__10:00"
  service_type: string;
  start_time: string;
  end_time: string;
  provider_name: string;
}

// Grid: rowKey -> day -> { planned: bool, actual: bool }
interface CellData {
  planned: boolean; // has a scheduled record
  actual: boolean;  // has a completed record
  scheduleId?: string;
}
type GridState = Record<string, Record<number, CellData>>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDayOfWeek(year: number, month: number, day: number): string {
  const d = new Date(year, month - 1, day);
  return ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
}

function isDowColor(year: number, month: number, day: number): string {
  const dow = new Date(year, month - 1, day).getDay();
  if (dow === 0) return "text-red-500";
  if (dow === 6) return "text-blue-500";
  return "text-gray-700";
}

function makeRowKey(serviceType: string, startTime: string, endTime: string): string {
  return `${serviceType}__${startTime}__${endTime}`;
}

function toWareki(date: Date): string {
  const y = date.getFullYear();
  if (y >= 2019) return `令和${y - 2018}年${date.getMonth() + 1}月${date.getDate()}日`;
  return format(date, "yyyy年M月d日");
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ProvisionTicketsPage() {
  const supabase = createClient();

  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState(() => new Date());
  const [userData, setUserData] = useState<KaigoUser | null>(null);
  const [allStaff, setAllStaff] = useState<KaigoStaff[]>([]);
  const [providers, setProviders] = useState<KaigoProvider[]>([]);

  const [serviceRows, setServiceRows] = useState<ServiceRow[]>([]);
  const [grid, setGrid] = useState<GridState>({});
  const [scheduleIds, setScheduleIds] = useState<Record<string, string>>({}); // "rowKey__day" -> schedule id

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"draft" | "confirmed">("draft");

  // Add service row modal
  const [showAddRow, setShowAddRow] = useState(false);
  const [addRowForm, setAddRowForm] = useState({ start_time: "09:00", end_time: "10:00", service_type: "", service_code: "", service_name: "", provider_id: "" });
  const [showAddServiceSelector, setShowAddServiceSelector] = useState(false);
  // Edit row modal
  const [editRowKey, setEditRowKey] = useState<string | null>(null);
  const [editRowForm, setEditRowForm] = useState({ start_time: "", end_time: "", service_name: "", service_code: "" });
  const [showEditServiceSelector, setShowEditServiceSelector] = useState(false);

  // Derived
  const year = selectedMonth.getFullYear();
  const month = selectedMonth.getMonth() + 1;
  const daysCount = getDaysInMonth(selectedMonth);
  const days = useMemo(() => Array.from({ length: daysCount }, (_, i) => i + 1), [daysCount]);
  const monthStr = `${year}-${String(month).padStart(2, "0")}`;

  // ── Load master data ──────────────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      const [staffRes, providerRes] = await Promise.all([
        supabase.from("kaigo_staff").select("id, name").eq("status", "active").order("name"),
        supabase.from("kaigo_providers").select("id, provider_name").order("provider_name"),
      ]);
      setAllStaff(staffRes.data || []);
      setProviders(providerRes.data || []);
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load user details ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedUserId) { setUserData(null); return; }
    const load = async () => {
      const { data } = await supabase
        .from("kaigo_users")
        .select("id, name, name_kana, care_level, insurer_no, insured_no")
        .eq("id", selectedUserId)
        .single();
      setUserData(data as KaigoUser | null);
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUserId]);

  // ── Load grid data ────────────────────────────────────────────────────────
  const fetchGridData = useCallback(async () => {
    if (!selectedUserId) {
      setServiceRows([]);
      setGrid({});
      return;
    }
    setLoading(true);

    const from = `${monthStr}-01`;
    const to = `${monthStr}-${String(daysCount).padStart(2, "0")}`;

    const { data, error } = await supabase
      .from("kaigo_visit_schedule")
      .select("id, user_id, staff_id, visit_date, start_time, end_time, service_type, status, kaigo_staff(name)")
      .eq("user_id", selectedUserId)
      .gte("visit_date", from)
      .lte("visit_date", to)
      .order("start_time");

    if (error) {
      toast.error("データの取得に失敗しました");
      setLoading(false);
      return;
    }

    const schedules: VisitSchedule[] = (data || []).map((r: any) => ({
      id: r.id,
      user_id: r.user_id,
      staff_id: r.staff_id,
      visit_date: r.visit_date,
      start_time: r.start_time,
      end_time: r.end_time,
      service_type: r.service_type,
      status: r.status,
      staff_name: r.kaigo_staff?.name ?? null,
    }));

    // Build unique rows — group by service_type + start_time + end_time
    const rowMap = new Map<string, ServiceRow>();
    for (const s of schedules) {
      const key = makeRowKey(s.service_type, s.start_time, s.end_time);
      if (!rowMap.has(key)) {
        rowMap.set(key, {
          key,
          service_type: s.service_type,
          start_time: s.start_time,
          end_time: s.end_time,
          provider_name: "",
        });
      }
    }

    // Build grid
    const newGrid: GridState = {};
    const newSchedIds: Record<string, string> = {};
    for (const [key] of rowMap) {
      newGrid[key] = {};
    }

    for (const s of schedules) {
      const key = makeRowKey(s.service_type, s.start_time, s.end_time);
      const day = parseInt(s.visit_date.split("-")[2], 10);
      if (!newGrid[key]) newGrid[key] = {};
      if (!newGrid[key][day]) newGrid[key][day] = { planned: false, actual: false };

      if (s.status === "scheduled" || s.status === "changed") {
        newGrid[key][day].planned = true;
      }
      if (s.status === "completed") {
        newGrid[key][day].actual = true;
      }
      // Track schedule IDs
      newSchedIds[`${key}__${day}__${s.status}`] = s.id;
    }

    const rows = Array.from(rowMap.values()).sort((a, b) => a.start_time.localeCompare(b.start_time));
    setServiceRows(rows);
    setGrid(newGrid);
    setScheduleIds(newSchedIds);
    setLoading(false);
  }, [selectedUserId, monthStr, daysCount, supabase]);

  useEffect(() => {
    fetchGridData();
  }, [fetchGridData]);

  // ── Cell toggle handlers ──────────────────────────────────────────────────
  const togglePlanned = (rowKey: string, day: number) => {
    setGrid((prev) => {
      const cell = prev[rowKey]?.[day] ?? { planned: false, actual: false };
      return {
        ...prev,
        [rowKey]: {
          ...prev[rowKey],
          [day]: { ...cell, planned: !cell.planned },
        },
      };
    });
  };

  const toggleActual = (rowKey: string, day: number) => {
    setGrid((prev) => {
      const cell = prev[rowKey]?.[day] ?? { planned: false, actual: false };
      return {
        ...prev,
        [rowKey]: {
          ...prev[rowKey],
          [day]: { ...cell, actual: !cell.actual },
        },
      };
    });
  };

  // Bulk: set all days planned/actual for a row
  const setAllPlanned = (rowKey: string) => {
    setGrid((prev) => {
      const rowData = { ...(prev[rowKey] || {}) };
      for (const day of days) {
        rowData[day] = { ...(rowData[day] ?? { planned: false, actual: false }), planned: true };
      }
      return { ...prev, [rowKey]: rowData };
    });
  };

  const setWeekdaysPlanned = (rowKey: string) => {
    setGrid((prev) => {
      const rowData = { ...(prev[rowKey] || {}) };
      for (const day of days) {
        const dow = new Date(year, month - 1, day).getDay();
        if (dow !== 0 && dow !== 6) {
          rowData[day] = { ...(rowData[day] ?? { planned: false, actual: false }), planned: true };
        }
      }
      return { ...prev, [rowKey]: rowData };
    });
  };

  const clearPlanned = (rowKey: string) => {
    setGrid((prev) => {
      const rowData = { ...(prev[rowKey] || {}) };
      for (const day of days) {
        if (rowData[day]) rowData[day] = { ...rowData[day], planned: false };
      }
      return { ...prev, [rowKey]: rowData };
    });
  };

  const setAllActual = (rowKey: string) => {
    setGrid((prev) => {
      const rowData = { ...(prev[rowKey] || {}) };
      for (const day of days) {
        rowData[day] = { ...(rowData[day] ?? { planned: false, actual: false }), actual: true };
      }
      return { ...prev, [rowKey]: rowData };
    });
  };

  const setWeekdaysActual = (rowKey: string) => {
    setGrid((prev) => {
      const rowData = { ...(prev[rowKey] || {}) };
      for (const day of days) {
        const dow = new Date(year, month - 1, day).getDay();
        if (dow !== 0 && dow !== 6) {
          rowData[day] = { ...(rowData[day] ?? { planned: false, actual: false }), actual: true };
        }
      }
      return { ...prev, [rowKey]: rowData };
    });
  };

  const clearActual = (rowKey: string) => {
    setGrid((prev) => {
      const rowData = { ...(prev[rowKey] || {}) };
      for (const day of days) {
        if (rowData[day]) rowData[day] = { ...rowData[day], actual: false };
      }
      return { ...prev, [rowKey]: rowData };
    });
  };

  // ── Add service row ───────────────────────────────────────────────────────
  const handleAddRow = () => {
    if (!addRowForm.service_name) {
      toast.error("サービスを選択してください");
      return;
    }
    const key = makeRowKey(addRowForm.service_name, addRowForm.start_time + ":00", addRowForm.end_time + ":00");
    if (serviceRows.some((r) => r.key === key)) {
      toast.error("同じサービス行が既に存在します");
      return;
    }
    const provObj = providers.find((p) => p.id === addRowForm.provider_id);
    setServiceRows((prev) => [...prev, {
      key,
      service_type: addRowForm.service_name,
      start_time: addRowForm.start_time + ":00",
      end_time: addRowForm.end_time + ":00",
      provider_name: provObj?.provider_name ?? "",
    }]);
    setGrid((prev) => ({ ...prev, [key]: {} }));
    setShowAddRow(false);
  };

  const removeRow = (rowKey: string) => {
    setServiceRows((prev) => prev.filter((r) => r.key !== rowKey));
    setGrid((prev) => {
      const next = { ...prev };
      delete next[rowKey];
      return next;
    });
  };

  // ── Edit row ───────────────────────────────────────────────────────────────
  const openEditRow = (row: ServiceRow) => {
    setEditRowKey(row.key);
    setEditRowForm({
      start_time: row.start_time.slice(0, 5),
      end_time: row.end_time.slice(0, 5),
      service_name: row.service_type,
      service_code: "",
    });
  };

  const handleEditRowSave = () => {
    if (!editRowKey || !editRowForm.service_name) return;
    const oldRow = serviceRows.find((r) => r.key === editRowKey);
    if (!oldRow) return;

    const newKey = makeRowKey(editRowForm.service_name, editRowForm.start_time + ":00", editRowForm.end_time + ":00");

    // Update service row
    setServiceRows((prev) => prev.map((r) =>
      r.key === editRowKey
        ? { ...r, key: newKey, service_type: editRowForm.service_name, start_time: editRowForm.start_time + ":00", end_time: editRowForm.end_time + ":00" }
        : r
    ));

    // Move grid data to new key if key changed
    if (newKey !== editRowKey) {
      setGrid((prev) => {
        const next = { ...prev };
        next[newKey] = next[editRowKey] || {};
        delete next[editRowKey];
        return next;
      });
    }

    setEditRowKey(null);
  };

  // ── Save handler ──────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!selectedUserId) return;
    setSaving(true);
    try {
      const from = `${monthStr}-01`;
      const to = `${monthStr}-${String(daysCount).padStart(2, "0")}`;

      // Delete all visit_schedule for this user/month
      await supabase
        .from("kaigo_visit_schedule")
        .delete()
        .eq("user_id", selectedUserId)
        .gte("visit_date", from)
        .lte("visit_date", to);

      // Insert from grid
      const toInsert: Record<string, unknown>[] = [];
      for (const row of serviceRows) {
        const rowGrid = grid[row.key] || {};
        for (const day of days) {
          const cell = rowGrid[day];
          if (!cell) continue;
          const dateStr = `${monthStr}-${String(day).padStart(2, "0")}`;

          if (cell.planned) {
            toInsert.push({
              user_id: selectedUserId,
              visit_date: dateStr,
              start_time: row.start_time,
              end_time: row.end_time,
              service_type: row.service_type,
              status: "scheduled",
            });
          }
          if (cell.actual) {
            toInsert.push({
              user_id: selectedUserId,
              visit_date: dateStr,
              start_time: row.start_time,
              end_time: row.end_time,
              service_type: row.service_type,
              status: "completed",
            });
          }
        }
      }

      if (toInsert.length > 0) {
        const { error } = await supabase.from("kaigo_visit_schedule").insert(toInsert);
        if (error) throw error;
      }

      toast.success("提供票を保存しました");
      fetchGridData();
    } catch (err: unknown) {
      toast.error("保存に失敗しました: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  // ── Summaries ──────────────────────────────────────────────────────────────
  const daySummary = useMemo(() => {
    const planned: Record<number, number> = {};
    const actual: Record<number, number> = {};
    for (const day of days) { planned[day] = 0; actual[day] = 0; }
    for (const rowData of Object.values(grid)) {
      for (const [dayStr, cell] of Object.entries(rowData)) {
        const d = parseInt(dayStr, 10);
        if (cell.planned) planned[d] = (planned[d] ?? 0) + 1;
        if (cell.actual) actual[d] = (actual[d] ?? 0) + 1;
      }
    }
    return { planned, actual };
  }, [grid, days]);

  const totalPlanned = useMemo(() => Object.values(daySummary.planned).reduce((a, b) => a + b, 0), [daySummary]);
  const totalActual = useMemo(() => Object.values(daySummary.actual).reduce((a, b) => a + b, 0), [daySummary]);

  // ── Print ──────────────────────────────────────────────────────────────────
  const handlePrint = () => window.print();

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          #provision-ticket-print, #provision-ticket-print * { visibility: visible !important; }
          #provision-ticket-print { position: fixed; inset: 0; padding: 6mm; background: white; overflow: visible; }
          .no-print { display: none !important; }
          @page { size: A4 landscape; margin: 6mm; }
          table { border-collapse: collapse; font-size: 7pt; }
          th, td { border: 1px solid #333 !important; padding: 0.5mm 1mm !important; }
        }
      `}</style>

      <div className="flex h-full -m-6">
        <UserSidebar selectedUserId={selectedUserId} onSelectUser={setSelectedUserId} />

        <div className="flex-1 overflow-y-auto">
          {/* Header */}
          <div className="sticky top-0 z-10 bg-white border-b px-6 py-3 no-print">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <FileText size={22} className="text-blue-600" />
                <h1 className="text-lg font-bold text-gray-900">
                  サービス提供表（実績）（{format(selectedMonth, "yyyy年M月", { locale: ja })}）
                </h1>
                <span className={cn(
                  "text-xs font-medium px-2 py-0.5 rounded-full",
                  status === "draft" ? "bg-yellow-100 text-yellow-700" : "bg-green-100 text-green-700"
                )}>
                  {status === "draft" ? "下書き" : "完成"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {status === "draft" && (
                  <button
                    onClick={() => setStatus("confirmed")}
                    className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <Edit3 size={14} />
                    完成にする
                  </button>
                )}
                {status === "confirmed" && (
                  <button
                    onClick={() => setStatus("draft")}
                    className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <Edit3 size={14} />
                    下書きに戻す
                  </button>
                )}
                <button
                  onClick={handleSave}
                  disabled={saving || !selectedUserId}
                  className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  保存
                </button>
                <button
                  onClick={handlePrint}
                  className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <Printer size={14} />
                  印刷
                </button>
              </div>
            </div>
          </div>

          {!selectedUserId ? (
            <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
              左の利用者一覧から利用者を選択してください
            </div>
          ) : (
            <div className="p-6" id="provision-ticket-print">
              {/* ── User info header (利用票風) ── */}
              <div className="grid grid-cols-4 gap-3 mb-4">
                <div>
                  <label className="block text-[10px] text-gray-500 mb-0.5">保険者番号</label>
                  <div className="rounded border border-gray-300 px-2 py-1.5 text-sm bg-white min-h-[2rem]">
                    {userData?.insurer_no ?? ""}
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] text-gray-500 mb-0.5">被保険者番号</label>
                  <div className="rounded border border-gray-300 px-2 py-1.5 text-sm bg-white min-h-[2rem]">
                    {userData?.insured_no ?? ""}
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] text-gray-500 mb-0.5">利用者氏名</label>
                  <div className="rounded border border-gray-300 px-2 py-1.5 text-sm font-semibold bg-white min-h-[2rem]">
                    {userData?.name ?? ""}
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] text-gray-500 mb-0.5">要介護度</label>
                  <div className="rounded border border-gray-300 px-2 py-1.5 text-sm bg-white min-h-[2rem]">
                    {userData?.care_level ?? ""}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 mb-4">
                <div>
                  <label className="block text-[10px] text-gray-500 mb-0.5">提供月</label>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setSelectedMonth(subMonths(selectedMonth, 1))} className="rounded border p-1 hover:bg-gray-50"><ChevronLeft size={16} /></button>
                    <span className="text-sm font-semibold">{format(selectedMonth, "yyyy年M月", { locale: ja })}</span>
                    <button onClick={() => setSelectedMonth(addMonths(selectedMonth, 1))} className="rounded border p-1 hover:bg-gray-50"><ChevronRight size={16} /></button>
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] text-gray-500 mb-0.5">作成年月日</label>
                  <div className="rounded border border-gray-300 px-2 py-1.5 text-sm bg-white min-h-[2rem]">
                    {toWareki(new Date())}
                  </div>
                </div>
              </div>

              {/* ── Service grid header ── */}
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold text-gray-800">
                  サービス一覧（最大9件）
                </h2>
                <button
                  onClick={() => {
                    setAddRowForm({ start_time: "09:00", end_time: "10:00", service_type: "", service_code: "", service_name: "", provider_id: "" });
                    setShowAddRow(true);
                  }}
                  className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800 no-print"
                >
                  <Plus size={14} />
                  サービス追加
                </button>
              </div>

              {/* ── Grid table ── */}
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 size={24} className="animate-spin text-blue-500" />
                </div>
              ) : (
                <div className="overflow-x-auto border rounded-lg">
                  <table className="text-[10px] border-collapse" style={{ tableLayout: "fixed", width: "100%" }}>
                    <colgroup>
                      <col style={{ width: "52px" }} />
                      <col style={{ width: "80px" }} />
                      <col style={{ width: "38px" }} />
                      {days.map((d) => <col key={d} style={{ width: "22px" }} />)}
                      <col style={{ width: "26px" }} />
                      <col className="no-print" style={{ width: "20px" }} />
                    </colgroup>
                    <thead>
                      {/* Day numbers */}
                      <tr className="bg-gray-50">
                        <th className="border border-gray-300 px-1 py-0.5 text-left text-[9px] sticky left-0 bg-gray-50 z-10">時間帯</th>
                        <th className="border border-gray-300 px-1 py-0.5 text-left text-[9px]">サービス内容</th>
                        <th className="border border-gray-300 px-0 py-0.5 text-[8px]"></th>
                        {days.map((d) => (
                          <th key={d} className={cn(
                            "border border-gray-300 px-0 py-0.5 text-center font-semibold text-[9px]",
                            isDowColor(year, month, d)
                          )}>
                            {d}
                          </th>
                        ))}
                        <th className="border border-gray-300 px-0 py-0.5 text-center font-bold text-blue-700 text-[9px]">計</th>
                        <th className="border border-gray-300 no-print"></th>
                      </tr>
                      {/* Day of week */}
                      <tr className="bg-gray-50">
                        <th className="border border-gray-300 sticky left-0 bg-gray-50 z-10" colSpan={3}></th>
                        {days.map((d) => {
                          const dow = getDayOfWeek(year, month, d);
                          return (
                            <th key={`dow-${d}`} className={cn(
                              "border border-gray-300 px-0 py-0 text-center text-[8px] font-normal",
                              isDowColor(year, month, d)
                            )}>
                              {dow}
                            </th>
                          );
                        })}
                        <th className="border border-gray-300"></th>
                        <th className="border border-gray-300 no-print"></th>
                      </tr>
                    </thead>
                      {serviceRows.map((row) => {
                        const rowGrid = grid[row.key] || {};
                        const plannedCount = days.reduce((s, d) => s + (rowGrid[d]?.planned ? 1 : 0), 0);
                        const actualCount = days.reduce((s, d) => s + (rowGrid[d]?.actual ? 1 : 0), 0);

                        return (
                          <tbody key={row.key}>
                            {/* Planned row */}
                            <tr>
                              <td
                                className="border border-gray-300 px-1 py-0 text-[9px] text-gray-600 sticky left-0 bg-white z-10 cursor-pointer hover:bg-blue-50 no-print:cursor-pointer"
                                rowSpan={2}
                                onClick={() => openEditRow(row)}
                                title="クリックして編集"
                              >
                                {row.start_time.slice(0, 5)}
                                <br />〜{row.end_time.slice(0, 5)}
                              </td>
                              <td
                                className="border border-gray-300 px-1 py-0 text-[9px] cursor-pointer hover:bg-blue-50"
                                rowSpan={2}
                                onClick={() => openEditRow(row)}
                                title="クリックして編集"
                              >
                                {row.service_type}
                              </td>
                              <td className="border border-gray-300 px-0 py-0 text-center text-[8px]">
                                <div className="flex items-center justify-center gap-0.5">
                                  <span className="text-gray-500">予定</span>
                                  <button onClick={() => setAllPlanned(row.key)} className="text-blue-500 hover:underline no-print" title="全日">全</button>
                                  <button onClick={() => setWeekdaysPlanned(row.key)} className="text-green-600 hover:underline no-print" title="平日">平</button>
                                  <button onClick={() => clearPlanned(row.key)} className="text-red-500 hover:underline no-print" title="消去">消</button>
                                </div>
                              </td>
                              {days.map((d) => {
                                const cell = rowGrid[d];
                                const isOn = cell?.planned ?? false;
                                return (
                                  <td
                                    key={`p-${d}`}
                                    className={cn(
                                      "border border-gray-200 px-0 py-0 text-center cursor-pointer transition-colors",
                                      isOn ? "bg-blue-50" : "hover:bg-blue-50/50"
                                    )}
                                    onClick={() => togglePlanned(row.key, d)}
                                  >
                                    {isOn && <span className="text-blue-700 font-bold">1</span>}
                                  </td>
                                );
                              })}
                              <td className="border border-gray-300 px-0 py-0 text-center font-bold text-blue-700">
                                {plannedCount > 0 ? plannedCount : ""}
                              </td>
                              <td className="border border-gray-300 px-0 py-0 text-center no-print" rowSpan={2}>
                                <button
                                  onClick={() => removeRow(row.key)}
                                  className="text-gray-300 hover:text-red-500 transition-colors"
                                  title="行削除"
                                >
                                  <X size={10} />
                                </button>
                              </td>
                            </tr>
                            {/* Actual row */}
                            <tr>
                              <td className="border border-gray-300 px-0 py-0 text-center text-[8px]">
                                <div className="flex items-center justify-center gap-0.5">
                                  <span className="text-gray-500">実績</span>
                                  <button onClick={() => setAllActual(row.key)} className="text-blue-500 hover:underline no-print" title="全日">全</button>
                                  <button onClick={() => setWeekdaysActual(row.key)} className="text-green-600 hover:underline no-print" title="平日">平</button>
                                  <button onClick={() => clearActual(row.key)} className="text-red-500 hover:underline no-print" title="消去">消</button>
                                </div>
                              </td>
                              {days.map((d) => {
                                const cell = rowGrid[d];
                                const isOn = cell?.actual ?? false;
                                return (
                                  <td
                                    key={`a-${d}`}
                                    className={cn(
                                      "border border-gray-200 px-0 py-0 text-center cursor-pointer transition-colors",
                                      isOn ? "bg-green-50" : "hover:bg-green-50/50"
                                    )}
                                    onClick={() => toggleActual(row.key, d)}
                                  >
                                    {isOn && <span className="text-green-700 font-bold">1</span>}
                                  </td>
                                );
                              })}
                              <td className="border border-gray-300 px-0 py-0 text-center font-bold text-green-700">
                                {actualCount > 0 ? actualCount : ""}
                              </td>
                            </tr>
                          </tbody>
                        );
                      })}

                      {serviceRows.length === 0 && (
                        <tbody>
                          <tr>
                            <td colSpan={3 + days.length + 2} className="border border-gray-300 px-4 py-8 text-center text-gray-400">
                              サービスの予定がありません。「＋サービス追加」で追加するか、シフト管理から予定を作成してください。
                            </td>
                          </tr>
                        </tbody>
                      )}

                      {/* Summary rows */}
                      {serviceRows.length > 0 && (
                        <tbody>
                          <tr className="bg-blue-50/50">
                            <td colSpan={3} className="border border-gray-300 px-2 py-0.5 text-right font-bold text-blue-700 text-[10px]">
                              予定合計
                            </td>
                            {days.map((d) => (
                              <td key={`sp-${d}`} className="border border-gray-300 px-0 py-0 text-center font-bold text-blue-700">
                                {(daySummary.planned[d] ?? 0) > 0 ? daySummary.planned[d] : ""}
                              </td>
                            ))}
                            <td className="border border-gray-300 px-0 py-0 text-center font-bold text-blue-700">{totalPlanned > 0 ? totalPlanned : ""}</td>
                            <td className="border border-gray-300 no-print"></td>
                          </tr>
                          <tr className="bg-green-50/50">
                            <td colSpan={3} className="border border-gray-300 px-2 py-0.5 text-right font-bold text-green-700 text-[10px]">
                              実績合計
                            </td>
                            {days.map((d) => (
                              <td key={`sa-${d}`} className="border border-gray-300 px-0 py-0 text-center font-bold text-green-700">
                                {(daySummary.actual[d] ?? 0) > 0 ? daySummary.actual[d] : ""}
                              </td>
                            ))}
                            <td className="border border-gray-300 px-0 py-0 text-center font-bold text-green-700">{totalActual > 0 ? totalActual : ""}</td>
                            <td className="border border-gray-300 no-print"></td>
                          </tr>
                        </tbody>
                      )}
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Add service row modal */}
      {showAddRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="font-semibold text-gray-900">サービス行を追加</h2>
              <button onClick={() => setShowAddRow(false)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">開始時間</label>
                  <input type="time" value={addRowForm.start_time} onChange={(e) => setAddRowForm((f) => ({ ...f, start_time: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">終了時間</label>
                  <input type="time" value={addRowForm.end_time} onChange={(e) => setAddRowForm((f) => ({ ...f, end_time: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">サービス</label>
                <button
                  type="button"
                  onClick={() => setShowAddServiceSelector(true)}
                  className="w-full flex items-center justify-between rounded-lg border border-gray-300 px-3 py-2 text-sm text-left hover:bg-gray-50"
                >
                  <span className={addRowForm.service_name ? "text-gray-900" : "text-gray-400"}>
                    {addRowForm.service_name || "サービスを選択..."}
                  </span>
                </button>
                <ServiceSelector
                  open={showAddServiceSelector}
                  onClose={() => setShowAddServiceSelector(false)}
                  onSelect={(service) => {
                    setAddRowForm((f) => ({ ...f, service_type: service.categoryName, service_code: service.code, service_name: service.name }));
                    setShowAddServiceSelector(false);
                  }}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">事業所</label>
                <select value={addRowForm.provider_id} onChange={(e) => setAddRowForm((f) => ({ ...f, provider_id: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
                  <option value="">-- 選択 --</option>
                  {providers.map((p) => <option key={p.id} value={p.id}>{p.provider_name}</option>)}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t px-5 py-4">
              <button onClick={() => setShowAddRow(false)} className="rounded-lg border px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">キャンセル</button>
              <button onClick={handleAddRow} className="flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">
                <Plus size={14} /> 追加
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit row modal */}
      {editRowKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="font-semibold text-gray-900">サービス行を編集</h2>
              <button onClick={() => setEditRowKey(null)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">開始時間</label>
                  <input type="time" value={editRowForm.start_time} onChange={(e) => setEditRowForm((f) => ({ ...f, start_time: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">終了時間</label>
                  <input type="time" value={editRowForm.end_time} onChange={(e) => setEditRowForm((f) => ({ ...f, end_time: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">サービス</label>
                <button
                  type="button"
                  onClick={() => setShowEditServiceSelector(true)}
                  className="w-full flex items-center justify-between rounded-lg border border-gray-300 px-3 py-2 text-sm text-left hover:bg-gray-50"
                >
                  <span className={editRowForm.service_name ? "text-gray-900" : "text-gray-400"}>
                    {editRowForm.service_name || "サービスを選択..."}
                  </span>
                </button>
                <ServiceSelector
                  open={showEditServiceSelector}
                  onClose={() => setShowEditServiceSelector(false)}
                  onSelect={(service) => {
                    setEditRowForm((f) => ({ ...f, service_name: service.name, service_code: service.code }));
                    setShowEditServiceSelector(false);
                  }}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t px-5 py-4">
              <button onClick={() => setEditRowKey(null)} className="rounded-lg border px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">キャンセル</button>
              <button onClick={handleEditRowSave} className="flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">
                <Save size={14} /> 変更
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
