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
  Zap,
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
import Encoding from "encoding-japanese";
import { useBusinessType } from "@/lib/business-type-context";
import { resolveKohiForMonth } from "@/lib/kohi";
import {
  buildKyufuKanriFile,
  buildKeikakuhiFile,
  SERVICE_KIND_CODE,
  type KyufuKanriUser,
  type KeikakuhiUser,
} from "@/lib/kokuho-densou/build-kyotaku";

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
  const { currentOffice } = useBusinessType();

  const [billingMonth, setBillingMonth] = useState(initialMonth);
  const [users, setUsers] = useState<UserWithCert[]>(initialUsers);
  const [rows, setRows] = useState<BenefitManagementRow[]>(initialRows);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
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
      // Fetch all active users with certifications
      // PostgREST embed: clients -> client_insurance_records (FK client_id)
      // PostgREST default 1000 行制限対策で page-loop で全件取得
      type UsersRow = {
        id: string;
        name: string;
        client_insurance_records?: CareCertification | CareCertification[] | null;
      };
      const PAGE = 1000;
      const usersAll: UsersRow[] = [];
      let from = 0;
      while (true) {
        const { data: usersData, error: usersError } = await supabase
          .from("clients")
          .select(
            "id, name, client_insurance_records(id, client_id, insured_number, care_level, service_limit_amount, insurer_number)"
          )
          .eq("status", "active")
          .eq("is_facility", false)
          .is("deleted_at", null)
          .order("name")
          .range(from, from + PAGE - 1);
        if (usersError) throw usersError;
        if (!usersData || usersData.length === 0) break;
        usersAll.push(...(usersData as UsersRow[]));
        if (usersData.length < PAGE) break;
        from += PAGE;
      }

      const mappedUsers: UserWithCert[] = usersAll.map((u) => {
        const cert = Array.isArray(u.client_insurance_records)
          ? u.client_insurance_records[0] ?? null
          : u.client_insurance_records ?? null;
        return { id: u.id, name: u.name, certification: cert };
      });

      setUsers(mappedUsers);

      // Fetch benefit management rows for selected month (page-loop 1000 行制限対策)
      const rowsAll: BenefitManagementRow[] = [];
      {
        let fromR = 0;
        while (true) {
          const { data: rowsData, error: rowsError } = await supabase
            .from("kaigo_benefit_management")
            .select("*")
            .eq("billing_month", billingMonth)
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
      setRows(rowsAll);
    } catch (err: unknown) {
      console.error("benefits fetchData err:", err);
      toast.error("データの取得に失敗しました: " + formatSupabaseErr(err));
    } finally {
      setLoading(false);
    }
  }, [supabase, billingMonth]);

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

      // 大量 row の upsert は payload / URL が膨らみ HTTP 414/413 で失敗するため chunk 化
      for (const chunk of chunkArray(upsertRows, IN_CHUNK_SIZE)) {
        const { error: upsertError } = await supabase
          .from("kaigo_benefit_management")
          .upsert(chunk, {
            onConflict: "user_id,billing_month,service_type",
            ignoreDuplicates: false,
          });
        if (upsertError) throw upsertError;
      }

      toast.success(
        `${upsertRows.length}件の給付管理票を生成しました（${formatMonth(billingMonth)}）`
      );
      await fetchData();
    } catch (err: unknown) {
      console.error("benefits handleBulkGenerate err:", err);
      toast.error("一括生成に失敗しました: " + formatSupabaseErr(err));
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

  // 国保連伝送ファイル (正式形式: 給付管理票 8211/8221 + 計画費請求 7111/8121)
  const downloadSjis = (r: { content: string; fileName: string }) => {
    const sjis = Encoding.convert(Encoding.stringToCode(r.content), {
      to: "SJIS",
      from: "UNICODE",
    });
    const blob = new Blob([new Uint8Array(sjis)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = r.fileName;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const handleDensouExport = async () => {
    try {
      const groups = aggregateUserGroups(users, rows).filter((g) => g.rows.length > 0);
      if (groups.length === 0) {
        toast.error("対象月の給付管理データがありません (先に一括生成してください)");
        return;
      }
      const [y, m] = billingMonth.split("-").map(Number);

      // 自事業所 (居宅介護支援) の事業所番号・地域単価
      const { data: officeRow, error: oe } = await supabase
        .from("offices")
        .select("business_number, unit_price")
        .eq("id", currentOffice?.id ?? "")
        .maybeSingle();
      if (oe) throw new Error("事業所情報取得失敗: " + oe.message);
      const officeNumber = (officeRow?.business_number ?? "") as string;
      const unitPrice = (officeRow?.unit_price ?? 10) as number;

      const ids = groups.map((g) => g.user.id);
      // 生年月日/性別 + 認定有効期間
      const { data: cls, error: ce } = await supabase
        .from("clients").select("id, birth_date, gender").in("id", ids);
      if (ce) throw new Error("利用者取得失敗: " + ce.message);
      const clientExtra = new Map(
        ((cls ?? []) as { id: string; birth_date: string | null; gender: string | null }[]).map((c) => [c.id, c]),
      );
      const { data: certRows, error: cre } = await supabase
        .from("client_insurance_records")
        .select("client_id, certification_start_date, certification_end_date, effective_date")
        .in("client_id", ids)
        .order("effective_date", { ascending: false });
      if (cre) throw new Error("認定期間取得失敗: " + cre.message);
      const certPeriod = new Map<string, { s: string | null; e: string | null }>();
      for (const r of (certRows ?? []) as { client_id: string; certification_start_date: string | null; certification_end_date: string | null }[]) {
        if (!certPeriod.has(r.client_id)) {
          certPeriod.set(r.client_id, { s: r.certification_start_date, e: r.certification_end_date });
        }
      }
      // 公費 (生活保護等) — 計画費請求 7111/8121 の公費欄用。
      // client_kohi_records から対象月に有効な 1 件を解決 (未作成時は旧列にフォールバック)
      const kohiRes = await resolveKohiForMonth(supabase, ids, y, m);
      const kohiByClient = kohiRes.byClient;

      // サービス事業所番号 (provider_name → offices.business_number)
      const providerNames = Array.from(new Set(rows.map((r) => r.provider_name).filter(Boolean))) as string[];
      const officeNoByName = new Map<string, string>();
      if (providerNames.length > 0) {
        const { data: offs } = await supabase
          .from("offices").select("name, business_number").in("name", providerNames.slice(0, 100));
        for (const o of (offs ?? []) as { name: string; business_number: string | null }[]) {
          if (o.business_number) officeNoByName.set(o.name, o.business_number);
        }
      }

      // 居宅介護支援費の年度別単位数 (4 月始まりの年度)
      const fiscalYear = m >= 4 ? y : y - 1;
      const { data: rates, error: re } = await supabase
        .from("kaigo_care_support_rates")
        .select("care_level, units, service_code")
        .eq("fiscal_year", String(fiscalYear));
      if (re) throw new Error("年度別単位数取得失敗: " + re.message);
      const rateByLevel = new Map(
        ((rates ?? []) as { care_level: string; units: number; service_code: string }[]).map((r) => [r.care_level, r]),
      );

      const opts = { officeNumber, year: y, month: m, unitPrice };
      const kyufuUsers: KyufuKanriUser[] = groups.map((g) => ({
        userName: g.user.name,
        insurerNumber: g.user.certification?.insurer_number ?? "",
        insuredNumber: g.user.certification?.insured_number ?? "",
        birthDate: clientExtra.get(g.user.id)?.birth_date ?? null,
        gender: clientExtra.get(g.user.id)?.gender ?? null,
        careLevel: g.user.certification?.care_level ?? null,
        limitStart: certPeriod.get(g.user.id)?.s ?? null,
        limitEnd: certPeriod.get(g.user.id)?.e ?? null,
        limitUnits: g.user.certification?.service_limit_amount ?? 0,
        lines: g.rows.map((r) => ({
          officeNumber: r.provider_name ? officeNoByName.get(r.provider_name) ?? "" : "",
          serviceKindCode: SERVICE_KIND_CODE[r.service_type] ?? "",
          plannedUnits: r.planned_units,
        })),
      }));
      const keikakuUsers: KeikakuhiUser[] = groups.map((g) => {
        const rate = rateByLevel.get((g.user.certification?.care_level ?? "").trim());
        const insuredNumber = g.user.certification?.insured_number ?? "";
        const kohi = kohiByClient.get(g.user.id);
        return {
          userName: g.user.name,
          insurerNumber: g.user.certification?.insurer_number ?? "",
          insuredNumber,
          birthDate: clientExtra.get(g.user.id)?.birth_date ?? null,
          gender: clientExtra.get(g.user.id)?.gender ?? null,
          careLevel: g.user.certification?.care_level ?? null,
          certStart: certPeriod.get(g.user.id)?.s ?? null,
          certEnd: certPeriod.get(g.user.id)?.e ?? null,
          requestDate: null, // 届出年月日は未管理 → 認定開始日で代用 (警告表示)
          serviceCode: rate?.service_code ?? "",
          units: rate?.units ?? 0,
          // 公費 (生活保護等)。H 番号 = みなし2号 = 公費単独 (10割公費)
          kohiTandoku: /^h/i.test(insuredNumber.trim()),
          kohiHobetsu: kohi?.hobetsu ?? null,
          kohiFutanshaNumber: kohi?.futansha ?? null,
          kohiJukyushaNumber: kohi?.jukyusha ?? null,
        };
      });

      // 要支援 (介護予防支援) は kaigo_care_support_rates の旧コードの可能性がある
      // (R6.4〜 は 461111/461112、R8.6〜 は 4621xx。正確な区分は /billing/seikyu の
      //  国保請求タブがレセプト実データから出力する)
      const preWarnings: string[] = [];
      for (const u of keikakuUsers) {
        if ((u.careLevel ?? "").startsWith("要支援")) {
          preWarnings.push(
            `${u.userName}: 要支援 (介護予防支援) の計画費は「請求 → 国保請求」タブからの出力を推奨 (この画面は旧世代コード ${u.serviceCode || "未設定"} の可能性)`,
          );
        }
      }

      const f1 = buildKyufuKanriFile(kyufuUsers, opts);
      const f2 = buildKeikakuhiFile(keikakuUsers, opts);
      const warnings = [...preWarnings, ...f1.warnings, ...f2.warnings];
      if (warnings.length > 0) {
        const list = warnings.slice(0, 12).join("\n・");
        if (
          !window.confirm(
            `以下の項目が不足しています (伝送ソフトの取込チェックでエラーになる可能性があります):\n\n・${list}${warnings.length > 12 ? `\n…他 ${warnings.length - 12} 件` : ""}\n\nこのままファイルを出力しますか？`,
          )
        )
          return;
      }
      downloadSjis(f1);
      downloadSjis(f2);
      toast.success(
        `伝送ファイルを出力しました: ${f1.fileName} (給付管理票 ${f1.dataRecordCount} 件) / ${f2.fileName} (計画費 ${f2.dataRecordCount} 件)`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

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
            onClick={handleDensouExport}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 transition-colors disabled:opacity-50"
            title="国保連伝送用の正式形式 (給付管理票 8211/8221 + 計画費請求 7111/8121、Shift_JIS) を出力"
          >
            <Send size={14} />
            伝送ファイル
          </button>
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
