"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
  Download,
  Upload,
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

// A "row" in the provision ticket grid = unique combination of service + time
interface ServiceRow {
  key: string; // e.g. "身体介護1__09:00__10:00"
  service_type: string;
  start_time: string;
  end_time: string;
  staff_id?: string;
  staff_name?: string;
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
  const [serviceUnits, setServiceUnits] = useState<Record<string, number>>({}); // service_name -> units
  const [officeInfo, setOfficeInfo] = useState<{ provider_number?: string; office_name?: string } | null>(null);

  const [serviceRows, setServiceRows] = useState<ServiceRow[]>([]);
  const [grid, setGrid] = useState<GridState>({});
  const [scheduleIds, setScheduleIds] = useState<Record<string, string>>({}); // "rowKey__day" -> schedule id

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"draft" | "confirmed">("draft");
  const [isDirty, setIsDirty] = useState(false);

  // Add service row modal
  const [showAddRow, setShowAddRow] = useState(false);
  const [addRowForm, setAddRowForm] = useState({ start_time: "09:00", end_time: "10:00", service_type: "", service_code: "", service_name: "", staff_id: "" });
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
      const [staffRes, serviceCodeRes, officeRes] = await Promise.all([
        supabase.from("members").select("id, name").eq("status", "active").order("name"),
        supabase.from("kaigo_service_codes").select("service_name, units").eq("calculation_type", "基本"),
        // PostgREST 列エイリアスで旧フィールド名維持
        supabase.from("offices").select("provider_number:business_number, office_name:name").eq("app_type", "kaigo-app").limit(1).single(),
      ]);
      setAllStaff(staffRes.data || []);
      if (officeRes.data) setOfficeInfo(officeRes.data as { provider_number?: string; office_name?: string });
      // Build units lookup: service_name -> units
      const unitsMap: Record<string, number> = {};
      for (const sc of (serviceCodeRes.data || []) as { service_name: string; units: number }[]) {
        unitsMap[sc.service_name] = sc.units;
      }
      setServiceUnits(unitsMap);
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load user details ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedUserId) { setUserData(null); return; }
    const load = async () => {
      const { data } = await supabase
        .from("clients")
        .select("id, name, name_kana")
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
      .select("id, user_id, staff_id, visit_date, start_time, end_time, service_type, status, members(name)")
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
      staff_name: r.members?.name ?? null,
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

          staff_id: s.staff_id ?? undefined,
          staff_name: s.staff_name ?? undefined,
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

  // ── Dirty tracking & beforeunload ──────────────────────────────────────────
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  // Mark dirty on any grid/row change (wrap setters)
  const markDirty = () => setIsDirty(true);

  // ── Cell toggle handlers ──────────────────────────────────────────────────
  const togglePlanned = (rowKey: string, day: number) => {
    markDirty();
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
    markDirty();
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
    markDirty();
    setGrid((prev) => {
      const rowData = { ...(prev[rowKey] || {}) };
      for (const day of days) {
        rowData[day] = { ...(rowData[day] ?? { planned: false, actual: false }), planned: true };
      }
      return { ...prev, [rowKey]: rowData };
    });
  };

  const setWeekdaysPlanned = (rowKey: string) => {
    markDirty();
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
    markDirty();
    setGrid((prev) => {
      const rowData = { ...(prev[rowKey] || {}) };
      for (const day of days) {
        if (rowData[day]) rowData[day] = { ...rowData[day], planned: false };
      }
      return { ...prev, [rowKey]: rowData };
    });
  };

  const setAllActual = (rowKey: string) => {
    markDirty();
    setGrid((prev) => {
      const rowData = { ...(prev[rowKey] || {}) };
      for (const day of days) {
        rowData[day] = { ...(rowData[day] ?? { planned: false, actual: false }), actual: true };
      }
      return { ...prev, [rowKey]: rowData };
    });
  };

  const setWeekdaysActual = (rowKey: string) => {
    markDirty();
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
    markDirty();
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
    const staffObj = allStaff.find((s) => s.id === addRowForm.staff_id);
    setServiceRows((prev) => [...prev, {
      key,
      service_type: addRowForm.service_name,
      start_time: addRowForm.start_time + ":00",
      end_time: addRowForm.end_time + ":00",
      staff_id: addRowForm.staff_id || undefined,
      staff_name: staffObj?.name ?? undefined,
    }]);
    setGrid((prev) => ({ ...prev, [key]: {} }));
    setShowAddRow(false);
  };

  const removeRow = (rowKey: string) => {
    markDirty();
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

    markDirty();
    const newKey = makeRowKey(editRowForm.service_name, editRowForm.start_time + ":00", editRowForm.end_time + ":00");
    const existingRow = serviceRows.find((r) => r.key === newKey && r.key !== editRowKey);

    if (existingRow) {
      // Merge: combine grid data from old row into existing row
      setGrid((prev) => {
        const next = { ...prev };
        const oldData = next[editRowKey] || {};
        const existingData = { ...(next[newKey] || {}) };
        // Merge: OR the planned/actual flags
        for (const [dayStr, cell] of Object.entries(oldData)) {
          const d = parseInt(dayStr, 10);
          if (!existingData[d]) {
            existingData[d] = { ...cell };
          } else {
            existingData[d] = {
              planned: existingData[d].planned || cell.planned,
              actual: existingData[d].actual || cell.actual,
            };
          }
        }
        next[newKey] = existingData;
        delete next[editRowKey];
        return next;
      });
      // Remove old row
      setServiceRows((prev) => prev.filter((r) => r.key !== editRowKey));
    } else {
      // Simple rename
      setServiceRows((prev) => prev.map((r) =>
        r.key === editRowKey
          ? { ...r, key: newKey, service_type: editRowForm.service_name, start_time: editRowForm.start_time + ":00", end_time: editRowForm.end_time + ":00" }
          : r
      ));

      if (newKey !== editRowKey) {
        setGrid((prev) => {
          const next = { ...prev };
          next[newKey] = next[editRowKey] || {};
          delete next[editRowKey];
          return next;
        });
      }
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
              staff_id: row.staff_id || null,
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
              staff_id: row.staff_id || null,
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
      setIsDirty(false);
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

  // ── Unit calculation ───────────────────────────────────────────────────────
  const unitSummary = useMemo(() => {
    const rows: { service_type: string; plannedCount: number; actualCount: number; units: number; plannedUnits: number; actualUnits: number }[] = [];
    for (const row of serviceRows) {
      const rowGrid = grid[row.key] || {};
      const pCount = days.reduce((s, d) => s + (rowGrid[d]?.planned ? 1 : 0), 0);
      const aCount = days.reduce((s, d) => s + (rowGrid[d]?.actual ? 1 : 0), 0);
      const units = serviceUnits[row.service_type] ?? 0;
      rows.push({
        service_type: row.service_type,
        plannedCount: pCount,
        actualCount: aCount,
        units,
        plannedUnits: pCount * units,
        actualUnits: aCount * units,
      });
    }
    // Group by service_type
    const grouped = new Map<string, { service_type: string; plannedCount: number; actualCount: number; units: number; plannedUnits: number; actualUnits: number }>();
    for (const r of rows) {
      const existing = grouped.get(r.service_type);
      if (existing) {
        existing.plannedCount += r.plannedCount;
        existing.actualCount += r.actualCount;
        existing.plannedUnits += r.plannedUnits;
        existing.actualUnits += r.actualUnits;
      } else {
        grouped.set(r.service_type, { ...r });
      }
    }
    return Array.from(grouped.values());
  }, [serviceRows, grid, days, serviceUnits]);

  const totalPlannedUnits = useMemo(() => unitSummary.reduce((s, r) => s + r.plannedUnits, 0), [unitSummary]);
  const totalActualUnits = useMemo(() => unitSummary.reduce((s, r) => s + r.actualUnits, 0), [unitSummary]);

  // ── Print ──────────────────────────────────────────────────────────────────
  const handlePrint = () => window.print();

  // ── CSV Export (ケアプランデータ連携システム標準仕様 第6表 実績) ────────
  const handleCsvExport = () => {
    if (!selectedUserId) {
      toast.error("利用者を選択してください");
      return;
    }
    if (serviceRows.length === 0) {
      toast.error("サービス行がありません。サービスを追加するか、シフト管理からデータを作成してください。");
      return;
    }
    // 予定or実績が1つもなければ警告
    const hasAnyData = serviceRows.some((row) => {
      const rowGrid = grid[row.key] || {};
      return days.some((d) => rowGrid[d]?.planned || rowGrid[d]?.actual);
    });
    if (!hasAnyData) {
      toast.error("予定・実績が入力されていません");
      return;
    }

    const csvVersion = "202407"; // Version 4.1 (令和6年10月改定)
    const insurerNo = userData?.insurer_no ?? "";
    const insuredNo = userData?.insured_no ?? "";
    const periodYm = `${year}${String(month).padStart(2, "0")}`;
    const providerCode = officeInfo?.provider_number ?? "";
    const now = new Date();
    const timestamp = format(now, "yyyyMMddHHmmss");

    // サービス種類コードのマッピング
    const getServiceCategoryCode = (serviceType: string): string => {
      if (serviceType.includes("訪問介護") || serviceType.includes("身体") || serviceType.includes("生活")) return "11";
      if (serviceType.includes("訪問看護")) return "13";
      if (serviceType.includes("訪問リハ")) return "14";
      if (serviceType.includes("通所介護")) return "15";
      if (serviceType.includes("通所リハ")) return "16";
      if (serviceType.includes("福祉用具")) return "17";
      if (serviceType.includes("短期入所")) return "21";
      return "11"; // デフォルト: 訪問介護
    };

    // ヘッダー行
    const headers = [
      "CSVバージョン",
      "保険者番号",
      "被保険者番号",
      "利用対象年月",
      "サービス事業者コード",
      "サービス種類コード",
      "サービス内容/名称",
      "開始時刻",
      "終了時刻",
      ...days.map((d) => `${d}日予定`),
      ...days.map((d) => `${d}日実績`),
      "予定回数合計",
      "実績回数合計",
      "単位数",
      "予定単位合計",
      "実績単位合計",
    ];

    // データ行
    const dataRows: string[][] = [];
    for (const row of serviceRows) {
      const rowGrid = grid[row.key] || {};
      const categoryCode = getServiceCategoryCode(row.service_type);
      const plannedDays = days.map((d) => (rowGrid[d]?.planned ? "1" : ""));
      const actualDays = days.map((d) => (rowGrid[d]?.actual ? "1" : ""));
      const plannedCount = days.reduce((s, d) => s + (rowGrid[d]?.planned ? 1 : 0), 0);
      const actualCount = days.reduce((s, d) => s + (rowGrid[d]?.actual ? 1 : 0), 0);
      const units = serviceUnits[row.service_type] ?? 0;

      dataRows.push([
        csvVersion,
        insurerNo,
        insuredNo,
        periodYm,
        providerCode,
        categoryCode,
        row.service_type,
        row.start_time.slice(0, 5).replace(":", ""),
        row.end_time.slice(0, 5).replace(":", ""),
        ...plannedDays,
        ...actualDays,
        String(plannedCount),
        String(actualCount),
        String(units),
        String(plannedCount * units),
        String(actualCount * units),
      ]);
    }

    // CSV文字列を作成 (Shift-JIS互換のためBOMなしUTF-8で出力、必要に応じてShift-JISに変換)
    const escapeField = (v: string) => {
      if (v.includes(",") || v.includes('"') || v.includes("\n")) {
        return '"' + v.replace(/"/g, '""') + '"';
      }
      return v;
    };

    const csvLines = [
      headers.map(escapeField).join(","),
      ...dataRows.map((row) => row.map(escapeField).join(",")),
    ];
    const csvContent = csvLines.join("\r\n") + "\r\n";

    // Shift-JIS対応: TextEncoderではShift-JISにできないため、UTF-8 BOM付きで出力
    // (Excelで開くため)
    const bom = "\uFEFF";
    const blob = new Blob([bom + csvContent], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const serviceCategoryCode = serviceRows.length > 0 ? getServiceCategoryCode(serviceRows[0].service_type) : "11";
    a.href = url;
    a.download = `DLTJSK_${periodYm}_${providerCode || "0000000000"}_${serviceCategoryCode}_${timestamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("CSVファイルをダウンロードしました");
  };

  // ── CSV Import (ケアプランデータ連携 第6表 予定CSV取込) ──────────────────
  const csvImportRef = useRef<HTMLInputElement>(null);

  const handleCsvImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (csvImportRef.current) csvImportRef.current.value = "";

    try {
      const buf = await file.arrayBuffer();
      let text = "";
      try { text = new TextDecoder("shift-jis").decode(buf); } catch { text = new TextDecoder("utf-8").decode(buf); }
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length === 0) { toast.error("CSVファイルが空です"); return; }

      // ヘッダー行判定
      const firstLine = lines[0];
      const isHeader = !firstLine.match(/^\d/) && !firstLine.startsWith('"2');
      const dataLines = isHeader ? lines.slice(1) : lines;

      const parseCSVLine = (line: string): string[] => {
        const result: string[] = [];
        let current = "";
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (inQuotes) {
            if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
            else if (ch === '"') { inQuotes = false; }
            else { current += ch; }
          } else {
            if (ch === '"') { inQuotes = true; }
            else if (ch === ",") { result.push(current); current = ""; }
            else { current += ch; }
          }
        }
        result.push(current);
        return result;
      };

      let importedRows = 0;
      const newServiceRows = [...serviceRows];
      const newGrid = { ...grid };

      for (const line of dataLines) {
        const cols = parseCSVLine(line);
        if (cols.length < 10) continue;

        // 第6表CSV: cols[9]=サービス内容, cols[10]=開始時刻(HHMM), cols[11]=終了時刻(HHMM), cols[15-45]=日別フラグ
        const serviceName = cols[9]?.trim() || cols[6]?.trim() || "";
        const startHHMM = cols[10]?.trim() || cols[7]?.trim() || "";
        const endHHMM = cols[11]?.trim() || cols[8]?.trim() || "";

        if (!serviceName || !startHHMM) continue;

        // 時刻をHH:MM:00形式に変換
        const startTime = startHHMM.length === 4
          ? `${startHHMM.slice(0, 2)}:${startHHMM.slice(2)}:00`
          : startHHMM.includes(":") ? (startHHMM.length === 5 ? startHHMM + ":00" : startHHMM) : startHHMM;
        const endTime = endHHMM.length === 4
          ? `${endHHMM.slice(0, 2)}:${endHHMM.slice(2)}:00`
          : endHHMM.includes(":") ? (endHHMM.length === 5 ? endHHMM + ":00" : endHHMM) : endHHMM;

        const key = makeRowKey(serviceName, startTime, endTime);

        // サービス行がなければ追加
        if (!newServiceRows.some((r) => r.key === key)) {
          newServiceRows.push({
            key,
            service_type: serviceName,
            start_time: startTime,
            end_time: endTime,
          });
        }
        if (!newGrid[key]) newGrid[key] = {};

        // 日別予定フラグを取り込み (cols[15]〜cols[45] or cols[9+offset])
        // フレキシブルに: 数字列の後ろの方にある1/空白の連続31個を探す
        const dayOffset = cols.length > 46 ? 15 : 9;
        for (let d = 1; d <= daysCount; d++) {
          const idx = dayOffset + (d - 1);
          if (idx < cols.length) {
            const val = cols[idx]?.trim();
            if (val === "1") {
              if (!newGrid[key][d]) newGrid[key][d] = { planned: false, actual: false };
              newGrid[key][d].planned = true;
              importedRows++;
            }
          }
        }
      }

      setServiceRows(newServiceRows);
      setGrid(newGrid);
      markDirty();

      if (importedRows > 0) {
        toast.success(`CSV取込完了: ${importedRows}件の予定を反映しました`);
      } else {
        toast.info("取り込み可能なデータがありませんでした");
      }
    } catch (err) {
      console.error(err);
      toast.error("CSVの読み込みに失敗しました");
    }
  };

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
        <UserSidebar selectedUserId={selectedUserId} onSelectUser={(id) => {
          if (isDirty && !window.confirm("未保存の変更があります。破棄しますか？")) return;
          setIsDirty(false);
          setSelectedUserId(id);
        }} />

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
                <input ref={csvImportRef} type="file" accept=".csv" className="hidden" onChange={handleCsvImport} />
                <button
                  onClick={() => csvImportRef.current?.click()}
                  disabled={!selectedUserId}
                  className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  <Upload size={14} />
                  CSV取込
                </button>
                <button
                  onClick={handleCsvExport}
                  disabled={!selectedUserId || serviceRows.length === 0}
                  className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  <Download size={14} />
                  CSV出力
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
                    <button onClick={() => {
                      if (isDirty && !window.confirm("未保存の変更があります。破棄しますか？")) return;
                      setIsDirty(false);
                      setSelectedMonth(subMonths(selectedMonth, 1));
                    }} className="rounded border p-1 hover:bg-gray-50"><ChevronLeft size={16} /></button>
                    <span className="text-sm font-semibold">{format(selectedMonth, "yyyy年M月", { locale: ja })}</span>
                    <button onClick={() => {
                      if (isDirty && !window.confirm("未保存の変更があります。破棄しますか？")) return;
                      setIsDirty(false);
                      setSelectedMonth(addMonths(selectedMonth, 1));
                    }} className="rounded border p-1 hover:bg-gray-50"><ChevronRight size={16} /></button>
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
                    setAddRowForm({ start_time: "09:00", end_time: "10:00", service_type: "", service_code: "", service_name: "", staff_id: "" });
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
                  <table className="text-xs border-collapse" style={{ tableLayout: "fixed", width: "100%" }}>
                    <colgroup>
                      <col style={{ width: "62px" }} />
                      <col style={{ width: "100px" }} />
                      <col style={{ width: "62px" }} />
                      {days.map((d) => <col key={d} style={{ width: "24px" }} />)}
                      <col style={{ width: "28px" }} />
                      <col className="no-print" style={{ width: "20px" }} />
                    </colgroup>
                    <thead>
                      {/* Day numbers */}
                      <tr className="bg-gray-50">
                        <th className="border border-gray-300 px-1.5 py-1 text-left text-[11px] sticky left-0 bg-gray-50 z-10">時間帯</th>
                        <th className="border border-gray-300 px-1.5 py-1 text-left text-[11px]">サービス内容</th>
                        <th className="border border-gray-300 px-0 py-1 text-[9px]"></th>
                        {days.map((d) => (
                          <th key={d} className={cn(
                            "border border-gray-300 px-0 py-1 text-center font-semibold text-[11px]",
                            isDowColor(year, month, d)
                          )}>
                            {d}
                          </th>
                        ))}
                        <th className="border border-gray-300 px-0 py-1 text-center font-bold text-blue-700 text-[11px]">計</th>
                        <th className="border border-gray-300 no-print"></th>
                      </tr>
                      {/* Day of week */}
                      <tr className="bg-gray-50">
                        <th className="border border-gray-300 sticky left-0 bg-gray-50 z-10" colSpan={3}></th>
                        {days.map((d) => {
                          const dow = getDayOfWeek(year, month, d);
                          return (
                            <th key={`dow-${d}`} className={cn(
                              "border border-gray-300 px-0 py-0.5 text-center text-[10px] font-normal",
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
                                className="border border-gray-300 px-1.5 py-1 text-[11px] text-gray-700 sticky left-0 bg-white z-10 cursor-pointer hover:bg-blue-50"
                                rowSpan={2}
                                onClick={() => openEditRow(row)}
                                title="クリックして編集"
                              >
                                {row.start_time.slice(0, 5)}
                                <br />〜{row.end_time.slice(0, 5)}
                              </td>
                              <td
                                className="border border-gray-300 px-1.5 py-1 text-[11px] cursor-pointer hover:bg-blue-50"
                                rowSpan={2}
                                onClick={() => openEditRow(row)}
                                title="クリックして編集"
                              >
                                <div>{row.service_type}</div>
                                {row.staff_name && <div className="text-[9px] text-gray-400">{row.staff_name}</div>}
                              </td>
                              <td className="border border-gray-300 pl-1 pr-1.5 py-0.5 text-center text-[10px]">
                                <div className="flex items-center gap-1">
                                  <span className="text-gray-500 shrink-0">予定</span>
                                  <div className="flex gap-1 no-print">
                                    <button onClick={() => setAllPlanned(row.key)} className="text-blue-500 hover:underline" title="全日">全</button>
                                    <button onClick={() => setWeekdaysPlanned(row.key)} className="text-green-600 hover:underline" title="平日">平</button>
                                    <button onClick={() => clearPlanned(row.key)} className="text-red-500 hover:underline" title="消去">消</button>
                                  </div>
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
                              <td className="border border-gray-300 pl-1 pr-1.5 py-0.5 text-center text-[10px]">
                                <div className="flex items-center gap-1">
                                  <span className="text-gray-500 shrink-0">実績</span>
                                  <div className="flex gap-1 no-print">
                                    <button onClick={() => setAllActual(row.key)} className="text-blue-500 hover:underline" title="全日">全</button>
                                    <button onClick={() => setWeekdaysActual(row.key)} className="text-green-600 hover:underline" title="平日">平</button>
                                    <button onClick={() => clearActual(row.key)} className="text-red-500 hover:underline" title="消去">消</button>
                                  </div>
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
                            <td colSpan={3} className="border border-gray-300 px-2 py-1 text-right font-bold text-blue-700 text-xs">
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
                            <td colSpan={3} className="border border-gray-300 px-2 py-1 text-right font-bold text-green-700 text-xs">
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

              {/* ── Unit calculation summary (compact) ── */}
              {serviceRows.length > 0 && (
                <div className="mt-4 max-w-2xl">
                  <h3 className="text-xs font-semibold text-gray-600 mb-1">単位数計算</h3>
                  <table className="w-full text-xs border-collapse border rounded">
                    <thead>
                      <tr className="bg-gray-50">
                        <th className="border border-gray-200 px-2 py-1 text-left text-[10px] text-gray-500">サービス</th>
                        <th className="border border-gray-200 px-2 py-1 text-right text-[10px] text-gray-500 w-14">単位</th>
                        <th className="border border-gray-200 px-2 py-1 text-right text-[10px] text-blue-600 w-12">予定</th>
                        <th className="border border-gray-200 px-2 py-1 text-right text-[10px] text-blue-600 w-16">予定単位</th>
                        <th className="border border-gray-200 px-2 py-1 text-right text-[10px] text-green-600 w-12">実績</th>
                        <th className="border border-gray-200 px-2 py-1 text-right text-[10px] text-green-600 w-16">実績単位</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unitSummary.map((row) => (
                        <tr key={row.service_type}>
                          <td className="border border-gray-200 px-2 py-0.5">{row.service_type}</td>
                          <td className="border border-gray-200 px-2 py-0.5 text-right tabular-nums">
                            {row.units > 0 ? row.units.toLocaleString() : "—"}
                          </td>
                          <td className="border border-gray-200 px-2 py-0.5 text-right text-blue-700 tabular-nums">
                            {row.plannedCount || ""}
                          </td>
                          <td className="border border-gray-200 px-2 py-0.5 text-right text-blue-700 tabular-nums font-semibold">
                            {row.plannedUnits > 0 ? row.plannedUnits.toLocaleString() : ""}
                          </td>
                          <td className="border border-gray-200 px-2 py-0.5 text-right text-green-700 tabular-nums">
                            {row.actualCount || ""}
                          </td>
                          <td className="border border-gray-200 px-2 py-0.5 text-right text-green-700 tabular-nums font-semibold">
                            {row.actualUnits > 0 ? row.actualUnits.toLocaleString() : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-gray-50 font-bold text-xs">
                        <td className="border border-gray-200 px-2 py-1 text-right" colSpan={2}>合計</td>
                        <td className="border border-gray-200 px-2 py-1 text-right text-blue-700 tabular-nums">{totalPlanned || ""}</td>
                        <td className="border border-gray-200 px-2 py-1 text-right text-blue-700 tabular-nums">{totalPlannedUnits > 0 ? totalPlannedUnits.toLocaleString() : ""}</td>
                        <td className="border border-gray-200 px-2 py-1 text-right text-green-700 tabular-nums">{totalActual || ""}</td>
                        <td className="border border-gray-200 px-2 py-1 text-right text-green-700 tabular-nums">{totalActualUnits > 0 ? totalActualUnits.toLocaleString() : ""}</td>
                      </tr>
                    </tfoot>
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
                  <input type="time" value={addRowForm.start_time} onChange={(e) => {
                    const v = e.target.value;
                    setAddRowForm((f) => ({ ...f, start_time: v, end_time: f.end_time <= v ? v : f.end_time }));
                  }} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">終了時間</label>
                  <input type="time" value={addRowForm.end_time} min={addRowForm.start_time} onChange={(e) => {
                    const v = e.target.value;
                    setAddRowForm((f) => ({ ...f, end_time: v < f.start_time ? f.start_time : v }));
                  }} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
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
                <label className="block text-xs font-medium text-gray-500 mb-1">担当職員</label>
                <select value={addRowForm.staff_id} onChange={(e) => setAddRowForm((f) => ({ ...f, staff_id: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
                  <option value="">-- 選択 --</option>
                  {allStaff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
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
                  <input type="time" value={editRowForm.start_time} onChange={(e) => {
                    const v = e.target.value;
                    setEditRowForm((f) => ({ ...f, start_time: v, end_time: f.end_time <= v ? v : f.end_time }));
                  }} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">終了時間</label>
                  <input type="time" value={editRowForm.end_time} min={editRowForm.start_time} onChange={(e) => {
                    const v = e.target.value;
                    setEditRowForm((f) => ({ ...f, end_time: v < f.start_time ? f.start_time : v }));
                  }} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
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
