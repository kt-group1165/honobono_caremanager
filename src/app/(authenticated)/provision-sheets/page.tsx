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
  RefreshCw,
  CalendarDays,
  Upload,
  Plus,
  Pencil,
  X,
  Trash2,
} from "lucide-react";
import { format, getDaysInMonth, parseISO, startOfMonth } from "date-fns";
import { ja } from "date-fns/locale";

// ─── Types ────────────────────────────────────────────────────────────────────

interface KaigoUser {
  id: string;
  name: string;
  name_kana: string | null;
}

interface CarePlanService {
  id: string;
  care_plan_id: string;
  service_type: string;
  service_content: string;
  frequency: string | null;
  provider: string | null;
  start_time: string | null;   // "HH:MM:SS" or null
  end_time: string | null;
}

interface CarePlan {
  id: string;
  user_id: string;
  status: string;
  kaigo_care_plan_services: CarePlanService[];
}

interface ServiceRecord {
  id: string;
  user_id: string;
  service_date: string; // "YYYY-MM-DD"
  service_type: string;
  start_time: string | null;
  end_time: string | null;
  content: string | null;
}

type CellState = "empty" | "planned" | "actual";

/** グリッド行の一意キー = service_type + start_time + end_time */
interface ServiceRow {
  key: string;
  service_type: string;
  start_time: string | null;  // "HH:MM:SS" or null (時間未設定)
  end_time: string | null;
  service_content: string;
  provider: string | null;
  plan_id?: string;            // 紐づく care_plan_service.id (あれば)
}

// row key -> day (1..31) -> cell state
type GridState = Record<string, Record<number, CellState>>;

function makeRowKey(serviceType: string, start: string | null, end: string | null): string {
  return `${serviceType}|${start ?? ""}|${end ?? ""}`;
}

function formatTimeRange(start: string | null, end: string | null): string {
  if (!start && !end) return "";
  const s = start ? start.slice(0, 5) : "--:--";
  const e = end ? end.slice(0, 5) : "--:--";
  return `${s}〜${e}`;
}

function toDbTime(hhmm: string): string | null {
  // "09:00" -> "09:00:00". Empty -> null.
  if (!hhmm) return null;
  return hhmm.length === 5 ? `${hhmm}:00` : hhmm;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getCurrentMonth(): string {
  return format(new Date(), "yyyy-MM");
}

function formatMonthLabel(yyyyMm: string): string {
  if (!yyyyMm) return "";
  const [y, m] = yyyyMm.split("-");
  return `${y}年${parseInt(m, 10)}月`;
}

function getDayOfWeek(year: number, month: number, day: number): string {
  const d = new Date(year, month - 1, day);
  return ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
}

function isWeekend(year: number, month: number, day: number): boolean {
  const dow = new Date(year, month - 1, day).getDay();
  return dow === 0 || dow === 6;
}

// content field value used to mark planned vs actual
const PLANNED_CONTENT = "__予定__";
const ACTUAL_CONTENT = "__実績__";

// ─── Cell Component ───────────────────────────────────────────────────────────

function GridCell({
  state,
  onClick,
}: {
  state: CellState;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full h-full flex items-center justify-center transition-colors print:cursor-default ${
        state === "empty"
          ? "hover:bg-blue-50"
          : state === "planned"
          ? "hover:bg-blue-100"
          : "hover:bg-green-100"
      }`}
      title={
        state === "empty"
          ? "クリックして予定を追加"
          : state === "planned"
          ? "予定 → 実績に変更"
          : "実績 → 削除"
      }
    >
      {state === "planned" && (
        <span className="text-blue-600 font-bold text-base leading-none select-none print:text-black">
          ○
        </span>
      )}
      {state === "actual" && (
        <span className="text-green-700 font-bold text-base leading-none select-none print:text-black">
          ●
        </span>
      )}
    </button>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ProvisionSheetsPage() {
  const supabase = createClient();

  const [users, setUsers] = useState<KaigoUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string>(getCurrentMonth());

  const [rows, setRows] = useState<ServiceRow[]>([]);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [grid, setGrid] = useState<GridState>({});

  const [loadingGrid, setLoadingGrid] = useState(false);
  const [saving, setSaving] = useState(false);

  // 行追加モーダル
  const [showAddRow, setShowAddRow] = useState(false);
  const [addRowForm, setAddRowForm] = useState({
    service_type: "",
    service_content: "",
    provider: "",
    start_time: "09:00",
    end_time: "10:00",
  });

  // 行編集モーダル
  const [editRowKey, setEditRowKey] = useState<string | null>(null);
  const [editRowForm, setEditRowForm] = useState({
    service_type: "",
    service_content: "",
    provider: "",
    start_time: "",
    end_time: "",
  });

  // Derived month info
  const { year, month, daysInMonth } = useMemo(() => {
    const [y, m] = selectedMonth.split("-").map(Number);
    return { year: y, month: m, daysInMonth: getDaysInMonth(new Date(y, m - 1)) };
  }, [selectedMonth]);

  const days = useMemo(
    () => Array.from({ length: daysInMonth }, (_, i) => i + 1),
    [daysInMonth]
  );

  const selectedUser = useMemo(
    () => users.find((u) => u.id === selectedUserId) ?? null,
    [users, selectedUserId]
  );

  // ── Load users ──────────────────────────────────────────────────────────────

  const fetchUsers = useCallback(async () => {
    const { data, error } = await supabase
      .from("kaigo_users")
      .select("id, name, name_kana")
      .eq("status", "active")
      .order("name_kana", { ascending: true });
    if (error) {
      toast.error("利用者の取得に失敗しました: " + error.message);
    } else {
      setUsers(data ?? []);
    }
  }, [supabase]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  // ── Load grid data ───────────────────────────────────────────────────────────

  const fetchGridData = useCallback(async () => {
    if (!selectedUserId || !selectedMonth) {
      setRows([]);
      setActivePlanId(null);
      setGrid({});
      return;
    }
    setLoadingGrid(true);
    try {
      // 1. Get active care plan services for this user
      const { data: plans, error: planError } = await supabase
        .from("kaigo_care_plans")
        .select("id, user_id, status, kaigo_care_plan_services(*)")
        .eq("user_id", selectedUserId)
        .eq("status", "active");

      if (planError) throw planError;

      const allPlans = (plans ?? []) as CarePlan[];
      const firstPlan = allPlans[0];
      setActivePlanId(firstPlan?.id ?? null);

      // service_type + start_time + end_time で一意な行を生成
      const rowMap = new Map<string, ServiceRow>();
      for (const plan of allPlans) {
        for (const svc of plan.kaigo_care_plan_services ?? []) {
          const key = makeRowKey(svc.service_type, svc.start_time, svc.end_time);
          if (!rowMap.has(key)) {
            rowMap.set(key, {
              key,
              service_type: svc.service_type,
              start_time: svc.start_time,
              end_time: svc.end_time,
              service_content: svc.service_content ?? "",
              provider: svc.provider,
              plan_id: svc.id,
            });
          }
        }
      }

      // 2. Load existing service records for user+month
      const monthStart = `${selectedMonth}-01`;
      const [y, m] = selectedMonth.split("-").map(Number);
      const lastDay = getDaysInMonth(new Date(y, m - 1));
      const monthEnd = `${selectedMonth}-${String(lastDay).padStart(2, "0")}`;

      const { data: records, error: recError } = await supabase
        .from("kaigo_service_records")
        .select("id, user_id, service_date, service_type, start_time, end_time, content")
        .eq("user_id", selectedUserId)
        .gte("service_date", monthStart)
        .lte("service_date", monthEnd);

      if (recError) throw recError;

      // 記録側から未登録の時間帯行を抽出してマージ
      for (const rec of (records ?? []) as ServiceRecord[]) {
        const key = makeRowKey(rec.service_type, rec.start_time, rec.end_time);
        if (!rowMap.has(key)) {
          rowMap.set(key, {
            key,
            service_type: rec.service_type,
            start_time: rec.start_time,
            end_time: rec.end_time,
            service_content: "",
            provider: null,
          });
        }
      }

      // 並び順: service_type → start_time
      const sortedRows = Array.from(rowMap.values()).sort((a, b) => {
        const typeCmp = a.service_type.localeCompare(b.service_type, "ja");
        if (typeCmp !== 0) return typeCmp;
        return (a.start_time ?? "").localeCompare(b.start_time ?? "");
      });
      setRows(sortedRows);

      // 3. Build initial grid from records
      const initialGrid: GridState = {};
      for (const r of sortedRows) {
        initialGrid[r.key] = {};
      }

      for (const rec of (records ?? []) as ServiceRecord[]) {
        const day = parseInt(rec.service_date.split("-")[2], 10);
        const key = makeRowKey(rec.service_type, rec.start_time, rec.end_time);
        if (!initialGrid[key]) initialGrid[key] = {};
        if (rec.content === ACTUAL_CONTENT) {
          initialGrid[key][day] = "actual";
        } else if (rec.content === PLANNED_CONTENT) {
          initialGrid[key][day] = "planned";
        }
      }

      setGrid(initialGrid);
    } catch (err: unknown) {
      toast.error(
        "データの取得に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setLoadingGrid(false);
    }
  }, [supabase, selectedUserId, selectedMonth]);

  useEffect(() => {
    fetchGridData();
  }, [fetchGridData]);

  // ── Cell click handler ───────────────────────────────────────────────────────

  const handleCellClick = useCallback(
    (rowKey: string, day: number) => {
      setGrid((prev) => {
        const rowState = prev[rowKey] ?? {};
        const current: CellState = rowState[day] ?? "empty";
        const next: CellState =
          current === "empty"
            ? "planned"
            : current === "planned"
            ? "actual"
            : "empty";
        return {
          ...prev,
          [rowKey]: {
            ...rowState,
            [day]: next,
          },
        };
      });
    },
    []
  );

  // ── Save handler ─────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!selectedUserId || !selectedMonth) return;
    setSaving(true);
    try {
      const [y, m] = selectedMonth.split("-").map(Number);
      const lastDay = getDaysInMonth(new Date(y, m - 1));
      const monthStart = `${selectedMonth}-01`;
      const monthEnd = `${selectedMonth}-${String(lastDay).padStart(2, "0")}`;

      // Delete all existing records for this user+month
      const { error: delError } = await supabase
        .from("kaigo_service_records")
        .delete()
        .eq("user_id", selectedUserId)
        .gte("service_date", monthStart)
        .lte("service_date", monthEnd);

      if (delError) throw delError;

      // Build new records from grid
      const rowByKey = new Map(rows.map((r) => [r.key, r]));

      const newRecords: {
        user_id: string;
        service_date: string;
        service_type: string;
        start_time: string | null;
        end_time: string | null;
        content: string;
      }[] = [];

      for (const [rowKey, dayMap] of Object.entries(grid)) {
        const row = rowByKey.get(rowKey);
        if (!row) continue;
        for (const [dayStr, state] of Object.entries(dayMap)) {
          if (state === "empty") continue;
          const day = parseInt(dayStr, 10);
          const dateStr = `${selectedMonth}-${String(day).padStart(2, "0")}`;
          newRecords.push({
            user_id: selectedUserId,
            service_date: dateStr,
            service_type: row.service_type,
            start_time: row.start_time,
            end_time: row.end_time,
            content: state === "actual" ? ACTUAL_CONTENT : PLANNED_CONTENT,
          });
        }
      }

      if (newRecords.length > 0) {
        const { error: insError } = await supabase
          .from("kaigo_service_records")
          .insert(newRecords);
        if (insError) throw insError;
      }

      toast.success("提供票を保存しました");
    } catch (err: unknown) {
      toast.error(
        "保存に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setSaving(false);
    }
  };

  // ── 行追加 ─────────────────────────────────────────────────────────────────

  const handleAddRow = async () => {
    const { service_type, service_content, provider, start_time, end_time } = addRowForm;
    if (!service_type.trim()) {
      toast.error("サービス種別を選択してください");
      return;
    }
    if (start_time && end_time && end_time <= start_time) {
      toast.error("終了時間は開始時間より後にしてください");
      return;
    }
    const startDb = toDbTime(start_time);
    const endDb = toDbTime(end_time);
    const newKey = makeRowKey(service_type, startDb, endDb);

    if (rows.some((r) => r.key === newKey)) {
      toast.error("同じサービス・時間帯の行が既に存在します");
      return;
    }

    // care_plan_services に INSERT（active プランがあれば）
    let planId: string | undefined;
    if (activePlanId) {
      try {
        const { data, error } = await supabase
          .from("kaigo_care_plan_services")
          .insert({
            care_plan_id: activePlanId,
            service_type,
            service_content: service_content || service_type,
            provider: provider || null,
            start_time: startDb,
            end_time: endDb,
          })
          .select()
          .single();
        if (error) throw error;
        planId = data?.id;
      } catch (err) {
        console.error(err);
        toast.error("行の保存に失敗しました（ローカルには追加されます）");
      }
    } else {
      toast.info("ケアプラン未登録のためローカルに追加しました。保存時は反映されます");
    }

    const newRow: ServiceRow = {
      key: newKey,
      service_type,
      start_time: startDb,
      end_time: endDb,
      service_content: service_content || service_type,
      provider: provider || null,
      plan_id: planId,
    };
    setRows((prev) => [...prev, newRow].sort((a, b) => {
      const typeCmp = a.service_type.localeCompare(b.service_type, "ja");
      if (typeCmp !== 0) return typeCmp;
      return (a.start_time ?? "").localeCompare(b.start_time ?? "");
    }));
    setGrid((prev) => ({ ...prev, [newKey]: {} }));
    setShowAddRow(false);
    setAddRowForm({
      service_type: "",
      service_content: "",
      provider: "",
      start_time: "09:00",
      end_time: "10:00",
    });
    toast.success("行を追加しました");
  };

  // ── 行編集開始 ─────────────────────────────────────────────────────────────

  const openEditRow = (row: ServiceRow) => {
    setEditRowKey(row.key);
    setEditRowForm({
      service_type: row.service_type,
      service_content: row.service_content,
      provider: row.provider ?? "",
      start_time: row.start_time ? row.start_time.slice(0, 5) : "",
      end_time: row.end_time ? row.end_time.slice(0, 5) : "",
    });
  };

  // ── 行編集保存 ─────────────────────────────────────────────────────────────

  const handleEditRow = async () => {
    if (!editRowKey) return;
    const oldRow = rows.find((r) => r.key === editRowKey);
    if (!oldRow) return;

    const { service_type, service_content, provider, start_time, end_time } = editRowForm;
    if (!service_type.trim()) {
      toast.error("サービス種別を入力してください");
      return;
    }
    if (start_time && end_time && end_time <= start_time) {
      toast.error("終了時間は開始時間より後にしてください");
      return;
    }
    const startDb = toDbTime(start_time);
    const endDb = toDbTime(end_time);
    const newKey = makeRowKey(service_type, startDb, endDb);

    if (newKey !== editRowKey && rows.some((r) => r.key === newKey)) {
      toast.error("同じサービス・時間帯の行が既に存在します");
      return;
    }

    // DB更新（care_plan_services）
    if (oldRow.plan_id) {
      try {
        const { error } = await supabase
          .from("kaigo_care_plan_services")
          .update({
            service_type,
            service_content: service_content || service_type,
            provider: provider || null,
            start_time: startDb,
            end_time: endDb,
          })
          .eq("id", oldRow.plan_id);
        if (error) throw error;
      } catch (err) {
        console.error(err);
        toast.error("DB更新に失敗しました");
        return;
      }
    }

    // 既存のサービス記録（当月分）の時間帯も更新
    if (selectedUserId && selectedMonth) {
      const [y, m] = selectedMonth.split("-").map(Number);
      const lastDay = getDaysInMonth(new Date(y, m - 1));
      const monthStart = `${selectedMonth}-01`;
      const monthEnd = `${selectedMonth}-${String(lastDay).padStart(2, "0")}`;
      let q = supabase
        .from("kaigo_service_records")
        .update({
          service_type,
          start_time: startDb,
          end_time: endDb,
        })
        .eq("user_id", selectedUserId)
        .eq("service_type", oldRow.service_type)
        .gte("service_date", monthStart)
        .lte("service_date", monthEnd);
      q = oldRow.start_time ? q.eq("start_time", oldRow.start_time) : q.is("start_time", null);
      q = oldRow.end_time ? q.eq("end_time", oldRow.end_time) : q.is("end_time", null);
      await q;
    }

    // 行とグリッドのキーを更新
    setRows((prev) =>
      prev
        .map((r) =>
          r.key === editRowKey
            ? {
                ...r,
                key: newKey,
                service_type,
                start_time: startDb,
                end_time: endDb,
                service_content: service_content || service_type,
                provider: provider || null,
              }
            : r
        )
        .sort((a, b) => {
          const typeCmp = a.service_type.localeCompare(b.service_type, "ja");
          if (typeCmp !== 0) return typeCmp;
          return (a.start_time ?? "").localeCompare(b.start_time ?? "");
        })
    );
    setGrid((prev) => {
      if (newKey === editRowKey) return prev;
      const next = { ...prev };
      next[newKey] = next[editRowKey] ?? {};
      delete next[editRowKey];
      return next;
    });

    setEditRowKey(null);
    toast.success("行を更新しました");
  };

  // ── 行削除 ─────────────────────────────────────────────────────────────────

  const handleDeleteRow = async (row: ServiceRow) => {
    if (!confirm(`${row.service_type}${row.start_time ? " " + formatTimeRange(row.start_time, row.end_time) : ""} の行を削除しますか？\n（当月の記録・ケアプラン明細も削除されます）`)) return;

    if (row.plan_id) {
      await supabase.from("kaigo_care_plan_services").delete().eq("id", row.plan_id);
    }
    if (selectedUserId && selectedMonth) {
      const [y, m] = selectedMonth.split("-").map(Number);
      const lastDay = getDaysInMonth(new Date(y, m - 1));
      const monthStart = `${selectedMonth}-01`;
      const monthEnd = `${selectedMonth}-${String(lastDay).padStart(2, "0")}`;
      let q = supabase
        .from("kaigo_service_records")
        .delete()
        .eq("user_id", selectedUserId)
        .eq("service_type", row.service_type)
        .gte("service_date", monthStart)
        .lte("service_date", monthEnd);
      q = row.start_time ? q.eq("start_time", row.start_time) : q.is("start_time", null);
      q = row.end_time ? q.eq("end_time", row.end_time) : q.is("end_time", null);
      await q;
    }
    setRows((prev) => prev.filter((r) => r.key !== row.key));
    setGrid((prev) => {
      const next = { ...prev };
      delete next[row.key];
      return next;
    });
    toast.success("行を削除しました");
  };

  // ── Summary calculations ─────────────────────────────────────────────────────

  const daySummary = useMemo(() => {
    const planned: Record<number, number> = {};
    const actual: Record<number, number> = {};
    for (const day of days) {
      planned[day] = 0;
      actual[day] = 0;
    }
    for (const dayMap of Object.values(grid)) {
      for (const [dayStr, state] of Object.entries(dayMap)) {
        const day = parseInt(dayStr, 10);
        if (state === "planned") planned[day] = (planned[day] ?? 0) + 1;
        if (state === "actual") actual[day] = (actual[day] ?? 0) + 1;
      }
    }
    return { planned, actual };
  }, [grid, days]);

  const rowSummary = useMemo(() => {
    const result: Record<string, { planned: number; actual: number }> = {};
    for (const row of rows) {
      result[row.key] = { planned: 0, actual: 0 };
    }
    for (const [rowKey, dayMap] of Object.entries(grid)) {
      if (!result[rowKey]) result[rowKey] = { planned: 0, actual: 0 };
      for (const state of Object.values(dayMap)) {
        if (state === "planned") result[rowKey].planned++;
        if (state === "actual") result[rowKey].actual++;
      }
    }
    return result;
  }, [grid, rows]);

  // ── Print handler ────────────────────────────────────────────────────────────

  const handlePrint = () => {
    window.print();
  };

  // ── CSV Import (ケアプランデータ連携 第6表 実績CSV取り込み) ─────────────
  const csvFileRef = useRef<HTMLInputElement>(null);

  const handleCsvImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset input
    if (csvFileRef.current) csvFileRef.current.value = "";

    try {
      const buf = await file.arrayBuffer();
      let text = "";
      try { text = new TextDecoder("shift-jis").decode(buf); } catch { text = new TextDecoder("utf-8").decode(buf); }
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      const lines = text.split(/\r?\n/).filter((l) => l.trim());

      if (lines.length === 0) {
        toast.error("CSVファイルが空です");
        return;
      }

      // ヘッダー行があるか判定（1行目が数字で始まらない場合はヘッダー）
      const firstLine = lines[0];
      const isHeader = !firstLine.match(/^\d/) && !firstLine.startsWith('"2');
      const dataLines = isHeader ? lines.slice(1) : lines;

      if (dataLines.length === 0) {
        toast.error("データ行がありません");
        return;
      }

      // CSV解析
      const parseCSVLine = (line: string): string[] => {
        const result: string[] = [];
        let current = "";
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (inQuotes) {
            if (ch === '"' && line[i + 1] === '"') {
              current += '"';
              i++;
            } else if (ch === '"') {
              inQuotes = false;
            } else {
              current += ch;
            }
          } else {
            if (ch === '"') {
              inQuotes = true;
            } else if (ch === ",") {
              result.push(current);
              current = "";
            } else {
              current += ch;
            }
          }
        }
        result.push(current);
        return result;
      };

      // 取り込みカウント
      let importedCount = 0;
      const newGrid = { ...grid };

      for (const line of dataLines) {
        const cols = parseCSVLine(line);
        if (cols.length < 9) continue;

        // 標準様式: CSVバージョン, 保険者番号, 被保険者番号, 利用対象年月,
        //           サービス事業者コード, サービス種類コード, サービス内容/名称,
        //           開始時刻, 終了時刻, 1日予定...31日予定, 1日実績...31日実績, ...
        // または独自形式を柔軟に解析

        const serviceNameCol = cols[6]?.trim() || "";
        // サービス名称から該当する行を特定
        let matchedKey = "";
        for (const row of rows) {
          if (serviceNameCol.includes(row.service_type) || row.service_type.includes(serviceNameCol)) {
            matchedKey = row.key;
            break;
          }
        }
        // サービス種類コードからマッチ
        if (!matchedKey && cols[5]) {
          const code = cols[5].trim();
          const codeMap: Record<string, string> = {
            "11": "訪問介護", "12": "訪問入浴介護", "13": "訪問看護",
            "14": "訪問リハビリテーション", "15": "通所介護", "16": "通所リハビリテーション",
            "17": "福祉用具貸与", "21": "短期入所",
          };
          const codeName = codeMap[code];
          if (codeName) {
            for (const row of rows) {
              if (row.service_type.includes(codeName) || codeName.includes(row.service_type)) {
                matchedKey = row.key;
                break;
              }
            }
          }
        }
        // サービス名で直接マッチ
        if (!matchedKey && serviceNameCol) {
          for (const row of rows) {
            if (row.service_type === serviceNameCol) {
              matchedKey = row.key;
              break;
            }
          }
        }

        if (!matchedKey) continue;

        // グリッドにない行は初期化
        if (!newGrid[matchedKey]) {
          newGrid[matchedKey] = {};
        }

        // 日別の実績フラグを解析
        // 予定: cols[9]〜cols[9+30] (1日〜31日)
        // 実績: cols[9+31]〜cols[9+61] (1日〜31日)
        const plannedOffset = 9;
        const actualOffset = 9 + daysInMonth;

        for (let d = 1; d <= daysInMonth; d++) {
          const pIdx = plannedOffset + (d - 1);
          const aIdx = actualOffset + (d - 1);
          const pVal = cols[pIdx]?.trim();
          const aVal = cols[aIdx]?.trim();

          const current = newGrid[matchedKey][d] ?? "empty";

          // 実績が「1」→ actual に設定
          if (aVal === "1") {
            newGrid[matchedKey][d] = "actual";
            importedCount++;
          } else if (pVal === "1" && current === "empty") {
            newGrid[matchedKey][d] = "planned";
            importedCount++;
          }
        }
      }

      setGrid(newGrid);

      if (importedCount > 0) {
        toast.success(`CSV取り込み完了: ${importedCount}件の予定/実績を反映しました`);
      } else {
        toast.info("取り込み可能なデータがありませんでした。サービス種別が一致するか確認してください。");
      }
    } catch (err) {
      console.error(err);
      toast.error("CSVの読み込みに失敗しました");
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── Print styles ── */}
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          #provision-sheet-print, #provision-sheet-print * { visibility: visible !important; }
          #provision-sheet-print { position: fixed; inset: 0; padding: 8mm; background: white; }
          #provision-sheet-controls { display: none !important; }
          @page { size: A4 landscape; margin: 8mm; }
          .no-print { display: none !important; }
          table { border-collapse: collapse; font-size: 8pt; }
          th, td { border: 1px solid #333 !important; padding: 1mm 1.5mm !important; }
        }
      `}</style>

      <div className="flex h-full -m-6">
        <UserSidebar selectedUserId={selectedUserId} onSelectUser={setSelectedUserId} />
        <div className="flex-1 overflow-y-auto p-6">
      <div className="space-y-5">
        {/* ── Header ── */}
        <div
          id="provision-sheet-controls"
          className="flex flex-wrap items-center justify-between gap-4 no-print"
        >
          <div className="flex items-center gap-2">
            <CalendarDays className="text-blue-600" size={24} />
            <h1 className="text-xl font-bold text-gray-900">提供票管理</h1>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={csvFileRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleCsvImport}
            />
            <button
              onClick={() => setShowAddRow(true)}
              disabled={!selectedUserId}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-50 border border-blue-300 px-3 py-2 text-sm text-blue-700 hover:bg-blue-100 transition-colors disabled:opacity-50"
            >
              <Plus size={14} />
              行追加
            </button>
            <button
              onClick={() => csvFileRef.current?.click()}
              disabled={!selectedUserId || rows.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              <Upload size={14} />
              CSV取込
            </button>
            <button
              onClick={fetchGridData}
              disabled={loadingGrid}
              className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={14} className={loadingGrid ? "animate-spin" : ""} />
              更新
            </button>
            <button
              onClick={handlePrint}
              className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
            >
              <Printer size={14} />
              印刷
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !selectedUserId || loadingGrid}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {saving ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Save size={14} />
              )}
              保存
            </button>
          </div>
        </div>

        {/* ── Controls ── */}
        <div
          id="provision-sheet-controls-selectors"
          className="flex flex-wrap gap-4 rounded-lg border bg-white p-4 shadow-sm no-print"
        >
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              対象月
            </label>
            <input
              type="month"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          {selectedUserId && (
            <div className="flex items-end">
              <span className="text-xs text-gray-500 pb-2">
                {formatMonthLabel(selectedMonth)} の提供票
              </span>
            </div>
          )}
        </div>

        {/* ── Empty state ── */}
        {!selectedUserId && (
          <div className="rounded-lg border bg-white py-16 text-center shadow-sm no-print">
            <FileText size={40} className="mx-auto mb-3 text-gray-300" />
            <p className="text-sm text-gray-500">利用者を選択してください</p>
          </div>
        )}

        {/* ── Loading ── */}
        {selectedUserId && loadingGrid && (
          <div className="flex items-center justify-center py-16 no-print">
            <Loader2 size={24} className="animate-spin text-blue-500" />
          </div>
        )}

        {/* ── No care plan services ── */}
        {selectedUserId && !loadingGrid && rows.length === 0 && (
          <div className="rounded-lg border bg-white py-10 text-center shadow-sm no-print">
            <p className="text-sm text-gray-500">
              有効なケアプランのサービス情報がありません
            </p>
            <p className="mt-1 text-xs text-gray-400">
              ケアプラン管理でサービスを登録するか、右上の「行追加」ボタンから直接追加してください
            </p>
          </div>
        )}

        {/* ── Grid (screen) ── */}
        {selectedUserId && !loadingGrid && rows.length > 0 && (
          <div className="rounded-lg border bg-white shadow-sm overflow-hidden no-print">
            <div style={{ maxHeight: "70vh" }}>
              <table
                className="text-xs border-collapse w-full table-fixed"
              >
                <thead className="sticky top-0 z-10 bg-gray-50">
                  {/* Month header */}
                  <tr>
                    <th
                      className="bg-gray-50 border border-gray-200 px-1 py-1 text-left font-semibold text-gray-700 whitespace-nowrap"
                      style={{ width: "170px" }}
                    >
                      サービス種別 / 時間帯
                    </th>
                    {days.map((day) => (
                      <th
                        key={day}
                        className={`border border-gray-200 px-0 py-0.5 text-center font-medium ${
                          isWeekend(year, month, day)
                            ? "bg-red-50 text-red-600"
                            : "text-gray-600"
                        }`}
                      >
                        <div className="text-[11px] leading-tight">{day}</div>
                        <div
                          className={`text-[9px] leading-tight ${
                            isWeekend(year, month, day)
                              ? "text-red-400"
                              : "text-gray-400"
                          }`}
                        >
                          {getDayOfWeek(year, month, day)}
                        </div>
                      </th>
                    ))}
                    <th
                      className="border border-gray-200 px-1 py-1 text-center font-medium text-gray-600 bg-gray-50"
                      style={{ width: "60px" }}
                    >
                      計
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => {
                    const rowState = grid[row.key] ?? {};
                    const summary = rowSummary[row.key] ?? {
                      planned: 0,
                      actual: 0,
                    };
                    const timeLabel = formatTimeRange(row.start_time, row.end_time);
                    return (
                      <tr
                        key={row.key}
                        className={idx % 2 === 0 ? "bg-white" : "bg-gray-50/50"}
                      >
                        <td
                          className="border border-gray-200 px-1 py-1 font-medium text-gray-800"
                          style={{
                            backgroundColor:
                              idx % 2 === 0 ? "white" : "rgb(249 250 251 / 0.5)",
                            width: "170px",
                          }}
                        >
                          <div className="flex items-start justify-between gap-1">
                            <div className="flex-1 min-w-0">
                              <div className="font-semibold text-[11px] leading-tight truncate">
                                {row.service_type}
                              </div>
                              {timeLabel && (
                                <div className="text-[10px] text-blue-600 font-medium">
                                  {timeLabel}
                                </div>
                              )}
                              {row.provider && (
                                <div className="text-[9px] text-gray-400 truncate">
                                  {row.provider}
                                </div>
                              )}
                            </div>
                            <div className="flex flex-col gap-0.5 no-print">
                              <button
                                onClick={() => openEditRow(row)}
                                className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors"
                                title="編集"
                              >
                                <Pencil size={10} />
                              </button>
                              <button
                                onClick={() => handleDeleteRow(row)}
                                className="rounded p-0.5 text-gray-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                                title="削除"
                              >
                                <Trash2 size={10} />
                              </button>
                            </div>
                          </div>
                        </td>
                        {days.map((day) => {
                          const state: CellState = rowState[day] ?? "empty";
                          return (
                            <td
                              key={day}
                              className={`border border-gray-200 p-0 ${
                                isWeekend(year, month, day) ? "bg-red-50/30" : ""
                              }`}
                              style={{ height: 30 }}
                            >
                              <GridCell
                                state={state}
                                onClick={() => handleCellClick(row.key, day)}
                              />
                            </td>
                          );
                        })}
                        <td className="border border-gray-200 px-2 py-1 text-center whitespace-nowrap">
                          <span className="text-blue-600 font-medium">
                            ○{summary.planned}
                          </span>
                          <span className="mx-1 text-gray-300">/</span>
                          <span className="text-green-700 font-medium">
                            ●{summary.actual}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  {/* Planned summary row */}
                  <tr className="bg-blue-50">
                    <td
                      className="sticky left-0 z-10 border border-gray-200 px-3 py-1 font-semibold text-blue-700 bg-blue-50"
                      style={{ minWidth: 200 }}
                    >
                      予定数（○）
                    </td>
                    {days.map((day) => (
                      <td
                        key={day}
                        className="border border-gray-200 text-center text-blue-700 font-semibold py-1"
                      >
                        {daySummary.planned[day] > 0
                          ? daySummary.planned[day]
                          : ""}
                      </td>
                    ))}
                    <td className="border border-gray-200 text-center text-blue-700 font-semibold py-1">
                      {Object.values(daySummary.planned).reduce(
                        (a, b) => a + b,
                        0
                      )}
                    </td>
                  </tr>
                  {/* Actual summary row */}
                  <tr className="bg-green-50">
                    <td
                      className="sticky left-0 z-10 border border-gray-200 px-3 py-1 font-semibold text-green-700 bg-green-50"
                      style={{ minWidth: 200 }}
                    >
                      実績数（●）
                    </td>
                    {days.map((day) => (
                      <td
                        key={day}
                        className="border border-gray-200 text-center text-green-700 font-semibold py-1"
                      >
                        {daySummary.actual[day] > 0
                          ? daySummary.actual[day]
                          : ""}
                      </td>
                    ))}
                    <td className="border border-gray-200 text-center text-green-700 font-semibold py-1">
                      {Object.values(daySummary.actual).reduce(
                        (a, b) => a + b,
                        0
                      )}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Legend */}
            <div className="flex items-center gap-4 px-4 py-2 border-t text-xs text-gray-500 bg-gray-50">
              <span className="font-medium text-gray-600">凡例:</span>
              <span className="flex items-center gap-1">
                <span className="text-blue-600 font-bold text-sm">○</span>
                予定
              </span>
              <span className="flex items-center gap-1">
                <span className="text-green-700 font-bold text-sm">●</span>
                実績
              </span>
              <span className="text-gray-400">
                セルをクリックして 空白→予定→実績→空白 と切り替えます
              </span>
            </div>
          </div>
        )}

        {/* ── Print version ── */}
        <div id="provision-sheet-print" className="hidden print:block">
          {selectedUser && (
            <>
              {/* Print Header */}
              <div className="mb-3 text-center">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-xs text-gray-500">様式第7</div>
                  <h1 className="text-lg font-bold tracking-wider">
                    サービス提供票
                  </h1>
                  <div className="text-xs text-gray-500">
                    {formatMonthLabel(selectedMonth)}
                  </div>
                </div>
                <div className="border-t border-b border-gray-800 py-1 grid grid-cols-3 gap-4 text-xs">
                  <div className="text-left">
                    <span className="font-semibold">利用者氏名: </span>
                    <span className="text-base font-bold">
                      {selectedUser.name}
                    </span>
                    {selectedUser.name_kana && (
                      <span className="ml-2 text-gray-500">
                        （{selectedUser.name_kana}）
                      </span>
                    )}
                  </div>
                  <div className="text-center">
                    <span className="font-semibold">対象年月: </span>
                    {formatMonthLabel(selectedMonth)}
                  </div>
                  <div className="text-right text-gray-500">
                    作成日:{" "}
                    {format(new Date(), "yyyy年M月d日", { locale: ja })}
                  </div>
                </div>
              </div>

              {/* Print Grid */}
              <table
                className="w-full border-collapse text-[7pt]"
                style={{ tableLayout: "fixed" }}
              >
                <thead>
                  <tr>
                    <th
                      className="border border-gray-700 px-1 py-0.5 bg-gray-100 text-left font-bold"
                      style={{ width: "150px" }}
                    >
                      サービス種別 / 時間帯
                    </th>
                    {days.map((day) => (
                      <th
                        key={day}
                        className={`border border-gray-700 text-center font-bold px-0 py-0.5 ${
                          isWeekend(year, month, day)
                            ? "bg-red-100"
                            : "bg-gray-100"
                        }`}
                      >
                        <div>{day}</div>
                        <div className="text-[6pt] font-normal text-gray-500">
                          {getDayOfWeek(year, month, day)}
                        </div>
                      </th>
                    ))}
                    <th className="border border-gray-700 bg-gray-100 text-center font-bold px-0.5">
                      合計
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const rowState = grid[row.key] ?? {};
                    const summary = rowSummary[row.key] ?? {
                      planned: 0,
                      actual: 0,
                    };
                    const timeLabel = formatTimeRange(row.start_time, row.end_time);
                    return (
                      <tr key={row.key}>
                        <td className="border border-gray-700 px-1 py-0.5 font-semibold text-left">
                          <div>{row.service_type}</div>
                          {timeLabel && (
                            <div className="text-[6pt] font-normal text-blue-700">
                              {timeLabel}
                            </div>
                          )}
                          {row.provider && (
                            <div className="font-normal text-gray-500 text-[6pt] truncate">
                              {row.provider}
                            </div>
                          )}
                        </td>
                        {days.map((day) => {
                          const state: CellState = rowState[day] ?? "empty";
                          return (
                            <td
                              key={day}
                              className={`border border-gray-700 text-center py-0.5 ${
                                isWeekend(year, month, day) ? "bg-red-50" : ""
                              }`}
                            >
                              {state === "planned" && (
                                <span className="font-bold">○</span>
                              )}
                              {state === "actual" && (
                                <span className="font-bold">●</span>
                              )}
                            </td>
                          );
                        })}
                        <td className="border border-gray-700 text-center px-0.5 py-0.5 bg-gray-50">
                          <div>○{summary.planned}</div>
                          <div>●{summary.actual}</div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-100">
                    <td className="border border-gray-700 px-1 py-0.5 font-bold text-center">
                      予定数（○）
                    </td>
                    {days.map((day) => (
                      <td
                        key={day}
                        className="border border-gray-700 text-center py-0.5 font-bold"
                      >
                        {daySummary.planned[day] > 0
                          ? daySummary.planned[day]
                          : ""}
                      </td>
                    ))}
                    <td className="border border-gray-700 text-center font-bold">
                      {Object.values(daySummary.planned).reduce(
                        (a, b) => a + b,
                        0
                      )}
                    </td>
                  </tr>
                  <tr className="bg-gray-50">
                    <td className="border border-gray-700 px-1 py-0.5 font-bold text-center">
                      実績数（●）
                    </td>
                    {days.map((day) => (
                      <td
                        key={day}
                        className="border border-gray-700 text-center py-0.5 font-bold"
                      >
                        {daySummary.actual[day] > 0
                          ? daySummary.actual[day]
                          : ""}
                      </td>
                    ))}
                    <td className="border border-gray-700 text-center font-bold">
                      {Object.values(daySummary.actual).reduce(
                        (a, b) => a + b,
                        0
                      )}
                    </td>
                  </tr>
                </tfoot>
              </table>

              {/* Print footer / signatures */}
              <div className="mt-4 grid grid-cols-3 gap-4 text-xs border-t border-gray-700 pt-2">
                <div className="border border-gray-400 p-2">
                  <div className="font-semibold mb-4">居宅介護支援事業所</div>
                  <div className="text-gray-400 text-[8pt]">担当ケアマネ印</div>
                </div>
                <div className="border border-gray-400 p-2">
                  <div className="font-semibold mb-4">サービス提供事業所</div>
                  <div className="text-gray-400 text-[8pt]">管理者印</div>
                </div>
                <div className="border border-gray-400 p-2">
                  <div className="font-semibold mb-4">利用者・家族確認</div>
                  <div className="text-gray-400 text-[8pt]">署名・押印</div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
        </div>
      </div>

      {/* ── 行追加モーダル ── */}
      {showAddRow && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 no-print"
          onClick={() => setShowAddRow(false)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b px-5 py-3">
              <h2 className="text-sm font-semibold text-gray-900">サービス行を追加</h2>
              <button
                onClick={() => setShowAddRow(false)}
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  サービス種別 <span className="text-red-500">*</span>
                </label>
                <select
                  value={addRowForm.service_type}
                  onChange={(e) =>
                    setAddRowForm((f) => ({ ...f, service_type: e.target.value }))
                  }
                  className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">選択してください</option>
                  <option value="訪問介護">訪問介護</option>
                  <option value="訪問入浴介護">訪問入浴介護</option>
                  <option value="訪問看護">訪問看護</option>
                  <option value="訪問リハビリテーション">訪問リハビリテーション</option>
                  <option value="通所介護">通所介護</option>
                  <option value="通所リハビリテーション">通所リハビリテーション</option>
                  <option value="短期入所生活介護">短期入所生活介護</option>
                  <option value="短期入所療養介護">短期入所療養介護</option>
                  <option value="福祉用具貸与">福祉用具貸与</option>
                  <option value="居宅療養管理指導">居宅療養管理指導</option>
                  <option value="定期巡回・随時対応型訪問介護看護">定期巡回・随時対応型訪問介護看護</option>
                  <option value="夜間対応型訪問介護">夜間対応型訪問介護</option>
                  <option value="その他">その他</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    開始時間
                  </label>
                  <input
                    type="time"
                    value={addRowForm.start_time}
                    onChange={(e) =>
                      setAddRowForm((f) => ({ ...f, start_time: e.target.value }))
                    }
                    className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    終了時間
                  </label>
                  <input
                    type="time"
                    value={addRowForm.end_time}
                    onChange={(e) =>
                      setAddRowForm((f) => ({ ...f, end_time: e.target.value }))
                    }
                    className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  サービス内容
                </label>
                <input
                  type="text"
                  value={addRowForm.service_content}
                  onChange={(e) =>
                    setAddRowForm((f) => ({ ...f, service_content: e.target.value }))
                  }
                  placeholder="例: 身体介護1"
                  className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  提供事業所
                </label>
                <input
                  type="text"
                  value={addRowForm.provider}
                  onChange={(e) =>
                    setAddRowForm((f) => ({ ...f, provider: e.target.value }))
                  }
                  placeholder="事業所名（任意）"
                  className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t bg-gray-50 px-5 py-3">
              <button
                onClick={() => setShowAddRow(false)}
                className="rounded border border-gray-300 bg-white px-4 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                キャンセル
              </button>
              <button
                onClick={handleAddRow}
                className="inline-flex items-center gap-1 rounded bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
              >
                <Plus size={12} />
                追加
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 行編集モーダル ── */}
      {editRowKey && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 no-print"
          onClick={() => setEditRowKey(null)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b px-5 py-3">
              <h2 className="text-sm font-semibold text-gray-900">サービス行を編集</h2>
              <button
                onClick={() => setEditRowKey(null)}
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  サービス種別 <span className="text-red-500">*</span>
                </label>
                <select
                  value={editRowForm.service_type}
                  onChange={(e) =>
                    setEditRowForm((f) => ({ ...f, service_type: e.target.value }))
                  }
                  className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">選択してください</option>
                  <option value="訪問介護">訪問介護</option>
                  <option value="訪問入浴介護">訪問入浴介護</option>
                  <option value="訪問看護">訪問看護</option>
                  <option value="訪問リハビリテーション">訪問リハビリテーション</option>
                  <option value="通所介護">通所介護</option>
                  <option value="通所リハビリテーション">通所リハビリテーション</option>
                  <option value="短期入所生活介護">短期入所生活介護</option>
                  <option value="短期入所療養介護">短期入所療養介護</option>
                  <option value="福祉用具貸与">福祉用具貸与</option>
                  <option value="居宅療養管理指導">居宅療養管理指導</option>
                  <option value="定期巡回・随時対応型訪問介護看護">定期巡回・随時対応型訪問介護看護</option>
                  <option value="夜間対応型訪問介護">夜間対応型訪問介護</option>
                  <option value="その他">その他</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    開始時間
                  </label>
                  <input
                    type="time"
                    value={editRowForm.start_time}
                    onChange={(e) =>
                      setEditRowForm((f) => ({ ...f, start_time: e.target.value }))
                    }
                    className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    終了時間
                  </label>
                  <input
                    type="time"
                    value={editRowForm.end_time}
                    onChange={(e) =>
                      setEditRowForm((f) => ({ ...f, end_time: e.target.value }))
                    }
                    className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  サービス内容
                </label>
                <input
                  type="text"
                  value={editRowForm.service_content}
                  onChange={(e) =>
                    setEditRowForm((f) => ({ ...f, service_content: e.target.value }))
                  }
                  className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  提供事業所
                </label>
                <input
                  type="text"
                  value={editRowForm.provider}
                  onChange={(e) =>
                    setEditRowForm((f) => ({ ...f, provider: e.target.value }))
                  }
                  className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t bg-gray-50 px-5 py-3">
              <button
                onClick={() => setEditRowKey(null)}
                className="rounded border border-gray-300 bg-white px-4 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                キャンセル
              </button>
              <button
                onClick={handleEditRow}
                className="inline-flex items-center gap-1 rounded bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
              >
                <Save size={12} />
                更新
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
