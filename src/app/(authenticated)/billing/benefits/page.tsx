"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  FileText,
  RefreshCw,
  Loader2,
  Download,
  Zap,
  CheckCircle,
  XCircle,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Users,
  ChevronLeft,
} from "lucide-react";
import { format } from "date-fns";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// 共通マスタ client_insurance_records の subset（Phase 2-3-8 で kaigo_care_certifications から張替え）
//   user_id              → client_id
//   support_limit_amount → service_limit_amount
interface CareCertification {
  id: string;
  client_id: string;
  insured_number: string;
  care_level: string;
  service_limit_amount: number;
  insurer_number?: string;
}

interface BenefitManagementRow {
  id: string;
  user_id: string;
  billing_month: string;
  service_type: string;
  provider_name: string | null;
  planned_units: number;
  actual_units: number;
  over_limit_units: number;
  status: "draft" | "confirmed" | "submitted";
  created_at: string;
  updated_at: string;
}

interface UserWithCert {
  id: string;
  name: string;
  certification: CareCertification | null;
}

interface UserGroup {
  user: UserWithCert;
  rows: BenefitManagementRow[];
  totalPlanned: number;
  totalActual: number;
  totalOverLimit: number;
  remaining: number;
  isOverLimit: boolean;
  status: "draft" | "confirmed" | "submitted";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVICE_TYPE_BASE_UNITS: Record<string, number> = {
  訪問介護: 247,
  訪問入浴介護: 830,
  訪問看護: 821,
  訪問リハビリテーション: 290,
  居宅療養管理指導: 295,
  通所介護: 656,
  通所リハビリテーション: 596,
  短期入所生活介護: 620,
  短期入所療養介護: 758,
  特定施設入居者生活介護: 535,
  福祉用具貸与: 100,
  居宅介護支援: 1053,
};

const STATUS_LABELS: Record<string, string> = {
  draft: "下書き",
  confirmed: "確定",
  submitted: "提出済",
};

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-600",
  confirmed: "bg-blue-100 text-blue-700",
  submitted: "bg-green-100 text-green-700",
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
const CARE_LEVEL_LIMITS: Record<string, number> = {
  要支援1: 5032,
  要支援2: 10531,
  要介護1: 16765,
  要介護2: 19705,
  要介護3: 27048,
  要介護4: 30938,
  要介護5: 36217,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCurrentMonth(): string {
  return format(new Date(), "yyyy-MM");
}

function formatMonth(yyyyMm: string): string {
  if (!yyyyMm) return "—";
  try {
    const [y, m] = yyyyMm.split("-");
    return `${y}年${parseInt(m, 10)}月`;
  } catch {
    return yyyyMm;
  }
}

function formatUnits(n: number): string {
  return n.toLocaleString("ja-JP") + "単位";
}

function aggregateUserGroups(
  users: UserWithCert[],
  rows: BenefitManagementRow[]
): UserGroup[] {
  const rowsByUser = new Map<string, BenefitManagementRow[]>();
  for (const row of rows) {
    if (!rowsByUser.has(row.user_id)) rowsByUser.set(row.user_id, []);
    rowsByUser.get(row.user_id)!.push(row);
  }

  return users
    .filter((u) => rowsByUser.has(u.id))
    .map((user) => {
      const userRows = rowsByUser.get(user.id) ?? [];
      const totalPlanned = userRows.reduce((s, r) => s + (r.planned_units ?? 0), 0);
      const totalActual = userRows.reduce((s, r) => s + (r.actual_units ?? 0), 0);
      const totalOverLimit = userRows.reduce(
        (s, r) => s + (r.over_limit_units ?? 0),
        0
      );
      const limit = user.certification?.service_limit_amount ?? 0;
      const remaining = limit - totalActual;
      const isOverLimit = remaining < 0;

      // Dominant status
      const hasSubmitted = userRows.some((r) => r.status === "submitted");
      const hasConfirmed = userRows.some((r) => r.status === "confirmed");
      const status: "draft" | "confirmed" | "submitted" = hasSubmitted
        ? "submitted"
        : hasConfirmed
        ? "confirmed"
        : "draft";

      return {
        user,
        rows: userRows,
        totalPlanned,
        totalActual,
        totalOverLimit,
        remaining,
        isOverLimit,
        status,
      };
    });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function BenefitsPage() {
  const supabase = createClient();

  const [billingMonth, setBillingMonth] = useState(getCurrentMonth());
  const [users, setUsers] = useState<UserWithCert[]>([]);
  const [rows, setRows] = useState<BenefitManagementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [expandedUsers, setExpandedUsers] = useState<Set<string>>(new Set());

  // Inline edit state: key = `${rowId}_planned` or `${rowId}_actual`
  const [editValues, setEditValues] = useState<Record<string, string>>({});

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch all active users with certifications
      // PostgREST embed: clients -> client_insurance_records (FK client_id)
      const { data: usersData, error: usersError } = await supabase
        .from("clients")
        .select(
          "id, name, client_insurance_records(id, client_id, insured_number, care_level, service_limit_amount, insurer_number)"
        )
        .eq("status", "active")
        .eq("is_facility", false)
        .is("deleted_at", null)
        .order("name");

      if (usersError) throw usersError;

      const mappedUsers: UserWithCert[] = (usersData ?? []).map((u: {
        id: string;
        name: string;
        client_insurance_records?: CareCertification | CareCertification[] | null;
      }) => {
        const cert = Array.isArray(u.client_insurance_records)
          ? u.client_insurance_records[0] ?? null
          : u.client_insurance_records ?? null;
        return { id: u.id, name: u.name, certification: cert };
      });

      setUsers(mappedUsers);

      // Fetch benefit management rows for selected month
      const { data: rowsData, error: rowsError } = await supabase
        .from("kaigo_benefit_management")
        .select("*")
        .eq("billing_month", billingMonth)
        .order("user_id")
        .order("service_type");

      if (rowsError) throw rowsError;
      setRows(rowsData ?? []);
    } catch (err: unknown) {
      toast.error(
        "データの取得に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setLoading(false);
    }
  }, [supabase, billingMonth]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    fetchData();
  }, [fetchData]);

  // Auto-expand all users with data
  useEffect(() => {
    const groups = aggregateUserGroups(users, rows);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    setExpandedUsers(new Set(groups.map((g) => g.user.id)));
  }, [users, rows]);

  // ---------------------------------------------------------------------------
  // Auto-generation
  // ---------------------------------------------------------------------------

  const handleBulkGenerate = async () => {
    setGenerating(true);
    try {
      // Fetch service records for the month
      const startDate = `${billingMonth}-01`;
      const [y, m] = billingMonth.split("-").map(Number);
      const lastDay = new Date(y, m, 0).getDate();
      const endDate = `${billingMonth}-${String(lastDay).padStart(2, "0")}`;

      const { data: serviceRecords, error: srError } = await supabase
        .from("kaigo_service_records")
        .select("id, user_id, service_type, service_date, content")
        .gte("service_date", startDate)
        .lte("service_date", endDate);

      if (srError) throw srError;

      if (!serviceRecords || serviceRecords.length === 0) {
        toast.info("対象月のサービス実績がありません");
        setGenerating(false);
        return;
      }

      // Group by user_id + service_type
      type AggKey = string;
      const grouped = new Map<
        AggKey,
        {
          user_id: string;
          service_type: string;
          record_count: number;
          total_units: number;
        }
      >();

      for (const sr of serviceRecords) {
        const key: AggKey = `${sr.user_id}__${sr.service_type}`;
        if (!grouped.has(key)) {
          grouped.set(key, {
            user_id: sr.user_id,
            service_type: sr.service_type,
            record_count: 0,
            total_units: 0,
          });
        }
        const entry = grouped.get(key)!;
        entry.record_count += 1;
        entry.total_units += SERVICE_TYPE_BASE_UNITS[sr.service_type] ?? 100;
      }

      // Upsert into kaigo_benefit_management
      const upsertRows = Array.from(grouped.values()).map((entry) => ({
        user_id: entry.user_id,
        billing_month: billingMonth,
        service_type: entry.service_type,
        planned_units: entry.total_units,
        actual_units: entry.total_units,
        over_limit_units: 0,
        status: "draft" as const,
      }));

      const { error: upsertError } = await supabase
        .from("kaigo_benefit_management")
        .upsert(upsertRows, {
          onConflict: "user_id,billing_month,service_type",
          ignoreDuplicates: false,
        });

      if (upsertError) throw upsertError;

      toast.success(
        `${upsertRows.length}件の給付管理票を生成しました（${formatMonth(billingMonth)}）`
      );
      await fetchData();
    } catch (err: unknown) {
      toast.error(
        "一括生成に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setGenerating(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Inline editing
  // ---------------------------------------------------------------------------

  const handleUnitChange = (
    rowId: string,
    field: "planned_units" | "actual_units",
    value: string
  ) => {
    setEditValues((prev) => ({ ...prev, [`${rowId}_${field}`]: value }));
  };

  const handleUnitBlur = async (
    row: BenefitManagementRow,
    field: "planned_units" | "actual_units"
  ) => {
    const key = `${row.id}_${field}`;
    const rawVal = editValues[key];
    if (rawVal === undefined) return; // not edited

    const newVal = parseInt(rawVal, 10);
    if (isNaN(newVal) || newVal < 0) {
      toast.error("正の整数を入力してください");
      setEditValues((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }

    const updatedPlanned =
      field === "planned_units" ? newVal : row.planned_units;
    const updatedActual =
      field === "actual_units" ? newVal : row.actual_units;

    // Find user's certification limit to recalculate over_limit
    // We'll just save and refetch; over_limit recalculated server-side or here
    const user = users.find((u) => u.id === row.user_id);
    const limit = user?.certification?.service_limit_amount ?? 0;

    // Recalculate over_limit for this row's user across all rows
    const siblingRows = rows.filter(
      (r) => r.user_id === row.user_id && r.id !== row.id
    );
    const siblingsActual = siblingRows.reduce(
      (s, r) => s + (r.actual_units ?? 0),
      0
    );
    const totalActual = siblingsActual + updatedActual;
    const overForUser = Math.max(0, totalActual - limit);
    // Apportion over_limit to this row proportionally (simplified: just put excess on this row)
    const thisRowOverLimit = Math.max(
      0,
      updatedActual - Math.max(0, limit - siblingsActual)
    );

    try {
      const { error } = await supabase
        .from("kaigo_benefit_management")
        .update({
          [field]: newVal,
          over_limit_units: thisRowOverLimit,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      if (error) throw error;

      // Update local state
      setRows((prev) =>
        prev.map((r) =>
          r.id === row.id
            ? {
                ...r,
                planned_units: updatedPlanned,
                actual_units: updatedActual,
                over_limit_units: thisRowOverLimit,
              }
            : r
        )
      );
      setEditValues((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      void overForUser; // suppress unused warning
    } catch (err: unknown) {
      toast.error(
        "更新に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    }
  };

  // ---------------------------------------------------------------------------
  // Status actions
  // ---------------------------------------------------------------------------

  const handleConfirm = async (userId: string) => {
    try {
      const { error } = await supabase
        .from("kaigo_benefit_management")
        .update({ status: "confirmed", updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("billing_month", billingMonth)
        .eq("status", "draft");
      if (error) throw error;
      toast.success("確定しました");
      setRows((prev) =>
        prev.map((r) =>
          r.user_id === userId && r.status === "draft"
            ? { ...r, status: "confirmed" }
            : r
        )
      );
    } catch (err: unknown) {
      toast.error(
        "確定に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    }
  };

  const handleRevoke = async (userId: string) => {
    try {
      const { error } = await supabase
        .from("kaigo_benefit_management")
        .update({ status: "draft", updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("billing_month", billingMonth)
        .eq("status", "confirmed");
      if (error) throw error;
      toast.success("取消しました");
      setRows((prev) =>
        prev.map((r) =>
          r.user_id === userId && r.status === "confirmed"
            ? { ...r, status: "draft" }
            : r
        )
      );
    } catch (err: unknown) {
      toast.error(
        "取消に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    }
  };

  // ---------------------------------------------------------------------------
  // CSV Export (国保連給付管理票形式)
  // ---------------------------------------------------------------------------

  const handleCsvExport = () => {
    const confirmedRows = rows.filter(
      (r) => r.status === "confirmed" || r.status === "submitted"
    );
    if (confirmedRows.length === 0) {
      toast.error("確定済みのデータがありません");
      return;
    }

    const headerLine = "給付管理票情報";
    const columnHeaders = [
      "証記載保険者番号",
      "被保険者番号",
      "サービス種類コード",
      "事業所番号",
      "計画単位数",
      "限度額管理対象単位数",
    ];

    const userMap = new Map(users.map((u) => [u.id, u]));

    const dataRows = confirmedRows.map((r) => {
      const user = userMap.get(r.user_id);
      const cert = user?.certification;
      return [
        cert?.insurer_number ?? "",
        cert?.insured_number ?? "",
        r.service_type,
        r.provider_name ?? "",
        String(r.planned_units ?? 0),
        String(r.actual_units ?? 0),
      ];
    });

    const csvLines = [
      headerLine,
      columnHeaders.map((c) => `"${c}"`).join(","),
      ...dataRows.map((row) =>
        row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")
      ),
    ];

    const csvContent = "\uFEFF" + csvLines.join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `給付管理票_${billingMonth.replace("-", "")}_${format(
      new Date(),
      "yyyyMMddHHmm"
    )}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("国保連CSV出力しました");
  };

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const userGroups = aggregateUserGroups(users, rows);
  const totalUsers = userGroups.length;
  const usersWithinLimit = userGroups.filter((g) => !g.isOverLimit).length;
  const usersOverLimit = userGroups.filter((g) => g.isOverLimit).length;
  const totalAllUnits = userGroups.reduce((s, g) => s + g.totalActual, 0);
  const totalAllLimit = userGroups.reduce(
    (s, g) => s + (g.user.certification?.service_limit_amount ?? 0),
    0
  );

  const toggleUser = (userId: string) => {
    setExpandedUsers((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <FileText className="text-blue-600" size={24} />
          <h1 className="text-xl font-bold text-gray-900">給付管理</h1>
          <span className="ml-2 rounded-full bg-gray-100 px-2.5 py-0.5 text-sm text-gray-600">
            {totalUsers}名
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={fetchData}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            更新
          </button>
          <button
            onClick={handleBulkGenerate}
            disabled={generating || loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-700 hover:bg-amber-100 transition-colors disabled:opacity-50"
          >
            {generating ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Zap size={14} />
            )}
            一括生成
          </button>
          <button
            onClick={handleCsvExport}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-sm font-medium text-green-700 hover:bg-green-100 transition-colors disabled:opacity-50"
          >
            <Download size={14} />
            国保連CSV出力
          </button>
        </div>
      </div>

      {/* Month selector */}
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium text-gray-700">対象月</label>
        <input
          type="month"
          value={billingMonth}
          onChange={(e) => setBillingMonth(e.target.value)}
          className="rounded-lg border px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <span className="text-sm text-gray-500">{formatMonth(billingMonth)}</span>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
            <Users size={13} className="text-blue-500" />
            対象利用者数
          </div>
          <p className="text-2xl font-bold text-gray-900">{totalUsers}名</p>
        </div>
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
            <CheckCircle size={13} className="text-green-500" />
            限度額内
          </div>
          <p className="text-2xl font-bold text-green-700">
            {usersWithinLimit}名
          </p>
        </div>
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
            <AlertTriangle size={13} className="text-red-500" />
            限度額超過
          </div>
          <p
            className={`text-2xl font-bold ${
              usersOverLimit > 0 ? "text-red-600" : "text-gray-400"
            }`}
          >
            {usersOverLimit}名
          </p>
        </div>
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
            <FileText size={13} className="text-purple-500" />
            合計単位 / 合計限度額
          </div>
          <p className="text-sm font-semibold text-gray-900">
            {totalAllUnits.toLocaleString("ja-JP")}
            <span className="mx-1 text-gray-400">/</span>
            {totalAllLimit.toLocaleString("ja-JP")}
          </p>
        </div>
      </div>

      {/* Main content */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={24} className="animate-spin text-blue-500" />
        </div>
      ) : userGroups.length === 0 ? (
        <div className="rounded-lg border bg-white py-20 text-center shadow-sm">
          <FileText size={40} className="mx-auto mb-3 opacity-20" />
          <p className="text-sm text-gray-500">
            {formatMonth(billingMonth)}の給付管理データがありません
          </p>
          <p className="mt-1 text-xs text-gray-400">
            「一括生成」でサービス実績から自動作成できます
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {userGroups.map((group) => (
            <UserGroupCard
              key={group.user.id}
              group={group}
              expanded={expandedUsers.has(group.user.id)}
              onToggle={() => toggleUser(group.user.id)}
              onConfirm={() => handleConfirm(group.user.id)}
              onRevoke={() => handleRevoke(group.user.id)}
              editValues={editValues}
              onUnitChange={handleUnitChange}
              onUnitBlur={handleUnitBlur}
            />
          ))}
        </div>
      )}

      {/* Back link */}
      <div>
        <Link
          href="/billing"
          className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
        >
          <ChevronLeft size={14} />
          請求管理に戻る
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// UserGroupCard sub-component
// ---------------------------------------------------------------------------

interface UserGroupCardProps {
  group: UserGroup;
  expanded: boolean;
  onToggle: () => void;
  onConfirm: () => void;
  onRevoke: () => void;
  editValues: Record<string, string>;
  onUnitChange: (
    rowId: string,
    field: "planned_units" | "actual_units",
    value: string
  ) => void;
  onUnitBlur: (
    row: BenefitManagementRow,
    field: "planned_units" | "actual_units"
  ) => void;
}

function UserGroupCard({
  group,
  expanded,
  onToggle,
  onConfirm,
  onRevoke,
  editValues,
  onUnitChange,
  onUnitBlur,
}: UserGroupCardProps) {
  const { user, rows, totalPlanned, totalActual, remaining, isOverLimit, status } =
    group;
  const cert = user.certification;
  const limit = cert?.service_limit_amount ?? 0;
  const usagePercent = limit > 0 ? Math.min((totalActual / limit) * 100, 100) : 0;

  return (
    <div
      className={`rounded-lg border bg-white shadow-sm overflow-hidden ${
        isOverLimit ? "border-red-300" : "border-gray-200"
      }`}
    >
      {/* User header row */}
      <div
        className={`flex items-center gap-3 px-4 py-3 cursor-pointer select-none hover:bg-gray-50 transition-colors ${
          isOverLimit ? "bg-red-50" : ""
        }`}
        onClick={onToggle}
      >
        {/* Expand icon */}
        <span className="text-gray-400 shrink-0">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>

        {/* User info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-gray-900 text-sm">
              {user.name}
            </span>
            {cert && (
              <>
                <span className="text-xs text-gray-500">
                  被保険者番号: {cert.insured_number}
                </span>
                <span className="rounded-full bg-purple-50 px-2 py-0.5 text-xs font-medium text-purple-700">
                  {cert.care_level}
                </span>
              </>
            )}
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[status]}`}
            >
              {STATUS_LABELS[status]}
            </span>
            {isOverLimit && (
              <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                <AlertTriangle size={11} />
                超過
              </span>
            )}
          </div>

          {/* Usage bar */}
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden max-w-xs">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  isOverLimit ? "bg-red-500" : "bg-blue-500"
                }`}
                style={{ width: `${usagePercent}%` }}
              />
            </div>
            <span
              className={`text-xs font-medium ${
                isOverLimit ? "text-red-600" : "text-gray-600"
              }`}
            >
              {totalActual.toLocaleString("ja-JP")} /{" "}
              {limit.toLocaleString("ja-JP")} 単位
            </span>
            <span
              className={`text-xs ${
                isOverLimit ? "text-red-500 font-semibold" : "text-gray-500"
              }`}
            >
              {isOverLimit
                ? `超過 ${Math.abs(remaining).toLocaleString("ja-JP")}単位`
                : `残 ${remaining.toLocaleString("ja-JP")}単位`}
            </span>
          </div>
        </div>

        {/* Action buttons */}
        <div
          className="flex items-center gap-2 shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          {status === "draft" && (
            <button
              onClick={onConfirm}
              className="inline-flex items-center gap-1 rounded-lg border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 transition-colors"
            >
              <CheckCircle size={12} />
              確定
            </button>
          )}
          {status === "confirmed" && (
            <button
              onClick={onRevoke}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 transition-colors"
            >
              <XCircle size={12} />
              取消
            </button>
          )}
        </div>
      </div>

      {/* Expanded detail rows */}
      {expanded && (
        <div className="border-t">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left font-medium text-gray-600">
                    サービス種別
                  </th>
                  <th className="px-4 py-2 text-left font-medium text-gray-600">
                    事業所名
                  </th>
                  <th className="px-4 py-2 text-right font-medium text-gray-600">
                    計画単位数
                  </th>
                  <th className="px-4 py-2 text-right font-medium text-gray-600">
                    限度額管理対象単位数
                  </th>
                  <th className="px-4 py-2 text-right font-medium text-gray-600">
                    限度額超過単位数
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => {
                  const plannedKey = `${row.id}_planned_units`;
                  const actualKey = `${row.id}_actual_units`;
                  const plannedVal =
                    editValues[plannedKey] ?? String(row.planned_units ?? 0);
                  const actualVal =
                    editValues[actualKey] ?? String(row.actual_units ?? 0);

                  return (
                    <tr key={row.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2 text-gray-800">
                        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                          {row.service_type}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-gray-600">
                        {row.provider_name ?? "—"}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <input
                          type="number"
                          min={0}
                          value={plannedVal}
                          onChange={(e) =>
                            onUnitChange(
                              row.id,
                              "planned_units",
                              e.target.value
                            )
                          }
                          onBlur={() => onUnitBlur(row, "planned_units")}
                          className="w-24 rounded border border-gray-200 px-2 py-0.5 text-right text-xs focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                        />
                      </td>
                      <td className="px-4 py-2 text-right">
                        <input
                          type="number"
                          min={0}
                          value={actualVal}
                          onChange={(e) =>
                            onUnitChange(
                              row.id,
                              "actual_units",
                              e.target.value
                            )
                          }
                          onBlur={() => onUnitBlur(row, "actual_units")}
                          className="w-24 rounded border border-gray-200 px-2 py-0.5 text-right text-xs focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                        />
                      </td>
                      <td
                        className={`px-4 py-2 text-right font-medium ${
                          (row.over_limit_units ?? 0) > 0
                            ? "text-red-600"
                            : "text-gray-500"
                        }`}
                      >
                        {(row.over_limit_units ?? 0).toLocaleString("ja-JP")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {/* Total row */}
              <tfoot className="border-t bg-gray-50">
                <tr>
                  <td
                    colSpan={2}
                    className="px-4 py-2 font-semibold text-gray-700"
                  >
                    合計
                  </td>
                  <td className="px-4 py-2 text-right font-semibold text-gray-800">
                    {totalPlanned.toLocaleString("ja-JP")}
                  </td>
                  <td className="px-4 py-2 text-right font-semibold text-gray-800">
                    {totalActual.toLocaleString("ja-JP")}
                  </td>
                  <td
                    className={`px-4 py-2 text-right font-semibold ${
                      group.totalOverLimit > 0
                        ? "text-red-600"
                        : "text-gray-500"
                    }`}
                  >
                    {group.totalOverLimit.toLocaleString("ja-JP")}
                  </td>
                </tr>
                <tr>
                  <td
                    colSpan={2}
                    className="px-4 py-2 text-xs text-gray-500"
                  >
                    区分支給限度額: {formatUnits(limit)}
                  </td>
                  <td colSpan={2} />
                  <td
                    className={`px-4 py-2 text-right text-xs font-semibold ${
                      isOverLimit ? "text-red-600" : "text-green-700"
                    }`}
                  >
                    残 {remaining.toLocaleString("ja-JP")}単位
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
