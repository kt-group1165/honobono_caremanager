"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  FileText,
  RefreshCw,
  Loader2,
  Download,
  CheckCircle,
  XCircle,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Users,
  ChevronLeft,
  Send,
} from "lucide-react";
import { format } from "date-fns";
import { resolveCertForMonth } from "@/lib/cert-for-month";
import { useBusinessType } from "@/lib/business-type-context";

// ---------------------------------------------------------------------------
// Types (= benefits-shared.ts から re-import、page.tsx は shared を直接 import)
// ---------------------------------------------------------------------------

import type {
  CareCertification,
  BenefitManagementRow,
  UserWithCert,
} from "./benefits-shared";

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

// chunked array helper: 大量 UUID を .in() に渡すと URI Too Long (HTTP 414) になり、
// Supabase JS は空 error message で reject → ブラウザ側で "Failed to fetch" と化けるため
// chunk 化。UUID 36 + URL encoding で 1 UUID ≒ 40 chars → 50 個で URL ~2KB に収まる。
// 旧 300 では URL ~12KB になり net::ERR_FAILED で 一括生成 失敗。
const IN_CHUNK_SIZE = 50;
function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// "Failed to fetch" 等の生 error を分かりやすい文字列に整形
function formatSupabaseErr(err: unknown): string {
  if (err instanceof Error) {
    if (/Failed to fetch/i.test(err.message)) {
      return "ネットワーク要求が失敗しました (URI が長すぎる/接続切断の可能性)。コンソールを確認してください";
    }
    return err.message;
  }
  if (typeof err === "object" && err !== null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
    const e = err as any;
    const code = e.code ? `${e.code}: ` : "";
    const msg = e.message || JSON.stringify(err);
    if (!msg || msg === "{}") return "サーバから空の応答 (おそらく URI Too Long / ネットワーク中断)。コンソールを確認してください";
    return code + msg;
  }
  return String(err);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BenefitsContent({
  initialMonth,
  initialUsers,
  initialRows,
}: {
  initialMonth: string;
  initialUsers: UserWithCert[];
  initialRows: BenefitManagementRow[];
}) {
  const supabase = useMemo(() => createClient(), []);
  // 自事業所。給付管理は事業所ごとに独立しているので、これで必ず絞る
  // (絞らないと全事業所分 2000 行超を読んで重く、他事業所の利用者まで見えてしまう)
  const { currentOffice } = useBusinessType();
  const officeId = currentOffice?.id ?? null;

  const [billingMonth, setBillingMonth] = useState(initialMonth);
  const [users, setUsers] = useState<UserWithCert[]>(initialUsers);
  const [rows, setRows] = useState<BenefitManagementRow[]>(initialRows);
  const [loading, setLoading] = useState(false);
  const [expandedUsers, setExpandedUsers] = useState<Set<string>>(
    () => new Set(aggregateUserGroups(initialUsers, initialRows).map((g) => g.user.id))
  );

  // Inline edit state: key = `${rowId}_planned` or `${rowId}_actual`
  const [editValues, setEditValues] = useState<Record<string, string>>({});

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const PAGE = 1000;

      // 自事業所の利用者 (client_office_assignments)。給付管理は事業所ごとに独立なので
      // これで必ず絞る。絞らないと全事業所分を読み込んでしまう。
      const officeClientIds: string[] = [];
      if (officeId) {
        let fromA = 0;
        while (true) {
          const { data, error } = await supabase
            .from("client_office_assignments")
            .select("client_id")
            .eq("office_id", officeId)
            .order("client_id", { ascending: true })
            .range(fromA, fromA + PAGE - 1);
          if (error) throw error;
          if (!data || data.length === 0) break;
          officeClientIds.push(...data.map((a: { client_id: string }) => a.client_id));
          if (data.length < PAGE) break;
          fromA += PAGE;
        }
      }

      // 当月の給付管理行 (自事業所の利用者のみ)。表示対象は「行がある利用者」だけなので、
      // 全利用者を取って全員分の認定を解決する必要はない (遅さの原因だった)。
      const rowsAll: BenefitManagementRow[] = [];
      if (!officeId || officeClientIds.length > 0) {
        const idChunks = officeId ? chunkArray(officeClientIds, IN_CHUNK_SIZE) : [null];
        for (const idChunk of idChunks) {
          let fromR = 0;
          while (true) {
            let q = supabase
              .from("kaigo_benefit_management")
              .select("*")
              .eq("billing_month", billingMonth);
            if (idChunk) q = q.in("user_id", idChunk);
            const { data: rowsData, error: rowsError } = await q
              .order("user_id")
              .order("service_type")
              .range(fromR, fromR + PAGE - 1);
            if (rowsError) throw rowsError;
            if (!rowsData || rowsData.length === 0) break;
            rowsAll.push(...(rowsData as BenefitManagementRow[]));
            if (rowsData.length < PAGE) break;
            fromR += PAGE;
          }
        }
      }

      // 当月行の利用者だけ 名前 + 認定 を解決
      type UsersRow = { id: string; name: string };
      const userIds = Array.from(new Set(rowsAll.map((r) => r.user_id)));
      const usersAll: UsersRow[] = [];
      for (let i = 0; i < userIds.length; i += 500) {
        const chunk = userIds.slice(i, i + 500);
        const { data: usersData, error: usersError } = await supabase
          .from("clients")
          .select("id, name")
          .in("id", chunk)
          .eq("status", "active")
          .eq("is_facility", false)
          .is("deleted_at", null)
          .order("name");
        if (usersError) throw usersError;
        usersAll.push(...((usersData ?? []) as UsersRow[]));
      }

      const [cy, cm] = billingMonth.split("-").map(Number);
      const certRes = await resolveCertForMonth(supabase, userIds, cy, cm);
      const mappedUsers: UserWithCert[] = usersAll.map((u) => {
        const cert = certRes.get(u.id);
        const certification: CareCertification | null = cert
          ? {
              id: "",
              client_id: u.id,
              insured_number: cert.insured_number ?? "",
              care_level: cert.care_level ?? "",
              service_limit_amount: cert.service_limit_amount ?? 0,
              insurer_number: cert.insurer_number ?? undefined,
            }
          : null;
        return { id: u.id, name: u.name, certification };
      });

      setUsers(mappedUsers);
      setRows(rowsAll);
    } catch (err: unknown) {
      console.error("benefits fetchData err:", err);
      toast.error("データの取得に失敗しました: " + formatSupabaseErr(err));
    } finally {
      setLoading(false);
    }
  }, [supabase, billingMonth, officeId]);

  // 初回 render は server からの initial データ。月変更時のみ refetch + expanded 再計算。
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    fetchData();
  }, [fetchData]);

  // Auto-expand all users with data (month-change 後の new users/rows でも再計算)
  useEffect(() => {
    if (isInitialMount.current) return;
    const groups = aggregateUserGroups(users, rows);
    setExpandedUsers(new Set(groups.map((g) => g.user.id)));
  }, [users, rows]);

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
      console.error("benefits handleUnitBlur err:", err);
      toast.error("更新に失敗しました: " + formatSupabaseErr(err));
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
      console.error("benefits handleConfirm err:", err);
      toast.error("確定に失敗しました: " + formatSupabaseErr(err));
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
      console.error("benefits handleRevoke err:", err);
      toast.error("取消に失敗しました: " + formatSupabaseErr(err));
    }
  };

  // ---------------------------------------------------------------------------
  // CSV Export (国保連給付管理票形式)
  // ---------------------------------------------------------------------------

  // ※ 旧「伝送ファイル」出力 (この画面からの 8211/8221 + 7111/8121 生成) は
  //   2026-07-08 総点検で廃止。加算・減算・世代マスタの反映が不完全な旧経路のため、
  //   伝送は 請求 (/billing/seikyu) → 国保請求タブ に一本化。
  //   この画面は給付管理データ (計画単位数等) の編集・確認専用。

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
          <Link
            href="/billing/seikyu"
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 transition-colors"
            title="国保連への伝送ファイル出力 (給付管理票 8211/8221 + 計画費請求 7111/8121) は 請求 → 国保請求タブから"
          >
            <Send size={14} />
            伝送は 請求 → 国保請求タブから
          </Link>
          <button
            onClick={handleCsvExport}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-sm font-medium text-green-700 hover:bg-green-100 transition-colors disabled:opacity-50"
            title="Excel で内容確認する用の CSV (伝送形式ではない)"
          >
            <Download size={14} />
            確認用CSV
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
            給付管理データは提供事業所の実績から取り込みます (migrations の取込スクリプト)
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
