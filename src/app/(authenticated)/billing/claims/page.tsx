"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  FileText,
  RefreshCw,
  Loader2,
  Users,
  Wallet,
  CheckCircle,
  Clock,
  Download,
  Zap,
  Check,
  X,
  Pencil,
  Save,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { format } from "date-fns";
import { ja } from "date-fns/locale";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ClaimStatus = "draft" | "confirmed" | "submitted";

interface Addings {
  initial: boolean;          // 初回加算 300単位
  hospitalization: boolean;  // 入院時情報連携加算 200単位
  discharge: boolean;        // 退院・退所加算 600単位
  outpatient: boolean;       // 通院時情報連携加算 50単位
}

interface ClaimRow {
  id: string;
  user_id: string;
  billing_month: string;
  care_support_code: string;
  care_support_name: string;
  units: number;
  unit_price: number;
  total_amount: number;
  insurance_amount: number;
  initial_addition: boolean;
  initial_addition_units: number;
  hospital_coordination: boolean;
  hospital_coordination_units: number;
  discharge_addition: boolean;
  discharge_addition_units: number;
  medical_coordination: boolean;
  medical_coordination_units: number;
  status: ClaimStatus;
  notes: string | null;
  kaigo_users?: { name: string };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CARE_LEVEL_MAP: Record<
  string,
  { units: number; code: string; name: string }
> = {
  要支援1: { units: 438, code: "461000", name: "居宅介護支援費（要支援）" },
  要支援2: { units: 438, code: "461000", name: "居宅介護支援費（要支援）" },
  要介護1: { units: 1076, code: "431000", name: "居宅介護支援費(i)" },
  要介護2: { units: 1076, code: "431000", name: "居宅介護支援費(i)" },
  要介護3: { units: 1398, code: "431100", name: "居宅介護支援費(ii)" },
  要介護4: { units: 1398, code: "431100", name: "居宅介護支援費(ii)" },
  要介護5: { units: 1398, code: "431100", name: "居宅介護支援費(ii)" },
};

const ADDITION_UNITS = {
  initial: 300,
  hospitalization: 200,
  discharge: 600,
  outpatient: 50,
} as const;

const STATUS_LABELS: Record<ClaimStatus, string> = {
  draft: "未確定",
  confirmed: "確定済",
  submitted: "請求済",
};

const STATUS_COLORS: Record<ClaimStatus, string> = {
  draft: "bg-yellow-50 text-yellow-700 border border-yellow-200",
  confirmed: "bg-green-50 text-green-700 border border-green-200",
  submitted: "bg-blue-50 text-blue-700 border border-blue-200",
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

function formatAmount(n: number): string {
  return n.toLocaleString("ja-JP") + "円";
}

function calcAdditionUnits(addings: Addings): number {
  return (
    (addings.initial ? ADDITION_UNITS.initial : 0) +
    (addings.hospitalization ? ADDITION_UNITS.hospitalization : 0) +
    (addings.discharge ? ADDITION_UNITS.discharge : 0) +
    (addings.outpatient ? ADDITION_UNITS.outpatient : 0)
  );
}

function calcTotals(
  baseUnits: number,
  addUnits: number,
  unitPrice: number
): { total_units: number; total_amount: number; insurance_amount: number } {
  const total_units = baseUnits + addUnits;
  const total_amount = Math.floor(total_units * unitPrice);
  return { total_units, total_amount, insurance_amount: total_amount };
}

// ---------------------------------------------------------------------------
// CSV Export
// ---------------------------------------------------------------------------

function generateCSV(
  claims: ClaimRow[],
  billingMonth: string,
  certMap: Map<string, { care_level: string; insurer_number: string | null; insured_number: string | null }>
): string {
  const BOM = "\uFEFF";
  const lines: string[] = [];

  // Header
  lines.push(
    [
      "レコード種別",
      "請求年月",
      "保険者番号",
      "被保険者番号",
      "サービス種類コード",
      "サービスコード",
      "単位数",
      "日数",
      "費用合計",
      "保険請求額",
      "利用者負担額",
      "要介護度",
      "利用者名",
    ].join(",")
  );

  for (const c of claims) {
    const cert = certMap.get(c.user_id);
    const additionUnitsSum =
      (c.initial_addition ? c.initial_addition_units : 0) +
      (c.hospital_coordination ? c.hospital_coordination_units : 0) +
      (c.discharge_addition ? c.discharge_addition_units : 0) +
      (c.medical_coordination ? c.medical_coordination_units : 0);
    const row = [
      "明細",
      billingMonth.replace("-", ""),
      cert?.insurer_number ?? "",
      cert?.insured_number ?? "",
      "43", // 居宅介護支援
      c.care_support_code,
      c.units + additionUnitsSum,
      "1",
      c.total_amount,
      c.insurance_amount,
      "0",
      cert?.care_level ?? "",
      (c.kaigo_users?.name ?? "").replace(/,/g, "　"),
    ];
    lines.push(row.join(","));
  }

  return BOM + lines.join("\r\n");
}

function downloadCSV(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Edit Modal
// ---------------------------------------------------------------------------

interface EditModalProps {
  claim: ClaimRow;
  certEntry: { care_level: string; insurer_number: string | null; insured_number: string | null } | undefined;
  onClose: () => void;
  onSave: (
    id: string,
    addings: Addings,
    unitPrice: number
  ) => Promise<void>;
}

function EditModal({ claim, certEntry, onClose, onSave }: EditModalProps) {
  const [addings, setAddings] = useState<Addings>({
    initial: claim.initial_addition,
    hospitalization: claim.hospital_coordination,
    discharge: claim.discharge_addition,
    outpatient: claim.medical_coordination,
  });
  const [unitPrice, setUnitPrice] = useState(claim.unit_price);
  const [saving, setSaving] = useState(false);

  const addUnits = calcAdditionUnits(addings);
  const { total_units, total_amount } = calcTotals(
    claim.units,
    addUnits,
    unitPrice
  );

  const toggle = (key: keyof Addings) =>
    setAddings((prev) => ({ ...prev, [key]: !prev[key] }));

  const handleSave = async () => {
    setSaving(true);
    await onSave(claim.id, addings, unitPrice);
    setSaving(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-xl border bg-white shadow-xl p-6 space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">
            レセプト編集 — {claim.kaigo_users?.name}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-2 text-sm text-gray-600">
          <div className="flex justify-between">
            <span>要介護度</span>
            <span className="font-medium text-gray-900">{certEntry?.care_level ?? "—"}</span>
          </div>
          <div className="flex justify-between">
            <span>基本単位数</span>
            <span className="font-medium text-gray-900">
              {claim.units.toLocaleString("ja-JP")} 単位
            </span>
          </div>
          <div className="flex justify-between">
            <span>サービス名称</span>
            <span className="font-medium text-gray-900">{claim.care_support_name}</span>
          </div>
        </div>

        {/* Additions */}
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase mb-2">
            加算
          </p>
          <div className="space-y-2">
            {(
              [
                ["initial", "初回加算", ADDITION_UNITS.initial],
                ["hospitalization", "入院時情報連携加算", ADDITION_UNITS.hospitalization],
                ["discharge", "退院・退所加算", ADDITION_UNITS.discharge],
                ["outpatient", "通院時情報連携加算", ADDITION_UNITS.outpatient],
              ] as [keyof Addings, string, number][]
            ).map(([key, label, units]) => (
              <label
                key={key}
                className="flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={addings[key]}
                  onChange={() => toggle(key)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="flex-1 text-sm text-gray-700">{label}</span>
                <span className="text-xs text-gray-400">+{units}単位</span>
              </label>
            ))}
          </div>
        </div>

        {/* Unit price */}
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">
            単位数単価 (円)
          </label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={unitPrice}
            onChange={(e) => setUnitPrice(parseFloat(e.target.value) || 10)}
            className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {/* Preview */}
        <div className="rounded-lg bg-gray-50 p-3 space-y-1 text-sm">
          <div className="flex justify-between text-gray-600">
            <span>加算単位合計</span>
            <span>+{addUnits.toLocaleString("ja-JP")} 単位</span>
          </div>
          <div className="flex justify-between font-medium text-gray-900">
            <span>合計単位数</span>
            <span>{total_units.toLocaleString("ja-JP")} 単位</span>
          </div>
          <div className="flex justify-between font-bold text-blue-700 border-t pt-1">
            <span>費用合計 (＝保険請求額)</span>
            <span>{formatAmount(total_amount)}</span>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
          >
            キャンセル
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function ClaimsPage() {
  const supabase = createClient();

  const [billingMonth, setBillingMonth] = useState(getCurrentMonth());
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [certMap, setCertMap] = useState<Map<string, { care_level: string; insurer_number: string | null; insured_number: string | null }>>(new Map());
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [editTarget, setEditTarget] = useState<ClaimRow | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchClaims = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("kaigo_care_support_claims")
        .select("*, kaigo_users(name)")
        .eq("billing_month", billingMonth)
        .order("created_at", { ascending: true });

      if (error) throw error;
      const rows = (data as ClaimRow[]) || [];
      setClaims(rows);

      // Fetch certifications for the users in these claims
      const userIds = [...new Set(rows.map((r) => r.user_id))];
      if (userIds.length > 0) {
        const { data: certs } = await supabase
          .from("kaigo_care_certifications")
          .select("user_id, care_level, insurer_number, insured_number")
          .in("user_id", userIds)
          .order("certification_date", { ascending: false });

        const map = new Map<string, { care_level: string; insurer_number: string | null; insured_number: string | null }>();
        for (const cert of certs || []) {
          if (!map.has(cert.user_id)) {
            map.set(cert.user_id, {
              care_level: cert.care_level,
              insurer_number: cert.insurer_number ?? null,
              insured_number: cert.insured_number ?? null,
            });
          }
        }
        setCertMap(map);
      } else {
        setCertMap(new Map());
      }
    } catch (err: unknown) {
      toast.error(
        "レセプトデータの取得に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setLoading(false);
    }
  }, [supabase, billingMonth]);

  useEffect(() => {
    fetchClaims();
  }, [fetchClaims]);

  // ── Summary ───────────────────────────────────────────────────────────────

  const summary = claims.reduce(
    (acc, c) => ({
      total: acc.total + 1,
      totalAmount: acc.totalAmount + (c.total_amount || 0),
      confirmed: acc.confirmed + (c.status !== "draft" ? 1 : 0),
      draft: acc.draft + (c.status === "draft" ? 1 : 0),
    }),
    { total: 0, totalAmount: 0, confirmed: 0, draft: 0 }
  );

  // ── Auto-generate ─────────────────────────────────────────────────────────

  const handleGenerate = async () => {
    if (
      !window.confirm(
        `${formatMonth(billingMonth)}のレセプトを一括生成します。\n既存データがある場合は上書きされます。よろしいですか？`
      )
    )
      return;

    setGenerating(true);
    try {
      // 1. Fetch active users
      const { data: users, error: usersErr } = await supabase
        .from("kaigo_users")
        .select("id, name")
        .eq("status", "active");
      if (usersErr) throw usersErr;
      if (!users || users.length === 0) {
        toast.error("在籍中の利用者が見つかりません");
        return;
      }

      const userIds = users.map((u: { id: string }) => u.id);

      // 2. Fetch active care plans
      const { data: plans, error: plansErr } = await supabase
        .from("kaigo_care_plans")
        .select("user_id")
        .in("user_id", userIds)
        .eq("status", "active");
      if (plansErr) throw plansErr;

      const activeUserIds = new Set(
        (plans || []).map((p: { user_id: string }) => p.user_id)
      );
      if (activeUserIds.size === 0) {
        toast.error("有効なケアプランを持つ利用者が見つかりません");
        return;
      }

      // 3. Fetch latest certifications for those users
      const { data: certs, error: certsErr } = await supabase
        .from("kaigo_care_certifications")
        .select("user_id, care_level, insurer_number, insured_number")
        .in("user_id", Array.from(activeUserIds))
        .order("certification_date", { ascending: false });
      if (certsErr) throw certsErr;

      // Build map: user_id -> most recent cert
      const certMap = new Map<
        string,
        {
          care_level: string;
          insurer_number: string | null;
          insured_number: string | null;
        }
      >();
      for (const cert of certs || []) {
        if (!certMap.has(cert.user_id)) {
          certMap.set(cert.user_id, {
            care_level: cert.care_level,
            insurer_number: cert.insurer_number ?? null,
            insured_number: cert.insured_number ?? null,
          });
        }
      }

      // 4. Delete existing claims for this month
      await supabase
        .from("kaigo_care_support_claims")
        .delete()
        .eq("billing_month", billingMonth);

      // 5. Build insert rows
      const now = new Date().toISOString();
      const rows: Record<string, unknown>[] = [];

      for (const user of users as { id: string; name: string }[]) {
        if (!activeUserIds.has(user.id)) continue;
        const cert = certMap.get(user.id);
        if (!cert) continue;

        const levelInfo = CARE_LEVEL_MAP[cert.care_level];
        if (!levelInfo) continue;

        const { total_amount } = calcTotals(
          levelInfo.units,
          0,
          10
        );

        rows.push({
          user_id: user.id,
          billing_month: billingMonth,
          care_support_code: levelInfo.code,
          care_support_name: levelInfo.name,
          units: levelInfo.units,
          unit_price: 10,
          total_amount,
          insurance_amount: total_amount,
          initial_addition: false,
          initial_addition_units: 0,
          hospital_coordination: false,
          hospital_coordination_units: 0,
          discharge_addition: false,
          discharge_addition_units: 0,
          medical_coordination: false,
          medical_coordination_units: 0,
          status: "draft",
        });
      }

      if (rows.length === 0) {
        toast.error("生成できるレセプトデータがありませんでした");
        return;
      }

      const { error: insertErr } = await supabase
        .from("kaigo_care_support_claims")
        .insert(rows);
      if (insertErr) throw insertErr;

      toast.success(
        `${formatMonth(billingMonth)}のレセプトを${rows.length}件生成しました`
      );
      fetchClaims();
    } catch (err: unknown) {
      toast.error(
        "一括生成に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setGenerating(false);
    }
  };

  // ── Confirm / Cancel per row ──────────────────────────────────────────────

  const handleSetStatus = async (id: string, status: ClaimStatus) => {
    try {
      const { error } = await supabase
        .from("kaigo_care_support_claims")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
      toast.success(
        status === "confirmed" ? "確定しました" : "取り消しました"
      );
      fetchClaims();
    } catch (err: unknown) {
      toast.error(
        "更新に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    }
  };

  // ── Confirm all ───────────────────────────────────────────────────────────

  const handleConfirmAll = async () => {
    const draftIds = claims
      .filter((c) => c.status === "draft")
      .map((c) => c.id);
    if (draftIds.length === 0) {
      toast.info("未確定のレセプトはありません");
      return;
    }
    if (
      !window.confirm(
        `未確定の${draftIds.length}件を全件確定します。よろしいですか？`
      )
    )
      return;

    setConfirmingAll(true);
    try {
      const { error } = await supabase
        .from("kaigo_care_support_claims")
        .update({ status: "confirmed", updated_at: new Date().toISOString() })
        .in("id", draftIds);
      if (error) throw error;
      toast.success(`${draftIds.length}件を確定しました`);
      fetchClaims();
    } catch (err: unknown) {
      toast.error(
        "全件確定に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setConfirmingAll(false);
    }
  };

  // ── Edit save ─────────────────────────────────────────────────────────────

  const handleEditSave = async (
    id: string,
    addings: Addings,
    unitPrice: number
  ) => {
    const claim = claims.find((c) => c.id === id);
    if (!claim) return;

    const addUnits = calcAdditionUnits(addings);
    const { total_amount, insurance_amount } = calcTotals(
      claim.units,
      addUnits,
      unitPrice
    );

    try {
      const { error } = await supabase
        .from("kaigo_care_support_claims")
        .update({
          unit_price: unitPrice,
          total_amount,
          insurance_amount,
          initial_addition: addings.initial,
          initial_addition_units: addings.initial ? ADDITION_UNITS.initial : 0,
          hospital_coordination: addings.hospitalization,
          hospital_coordination_units: addings.hospitalization ? ADDITION_UNITS.hospitalization : 0,
          discharge_addition: addings.discharge,
          discharge_addition_units: addings.discharge ? ADDITION_UNITS.discharge : 0,
          medical_coordination: addings.outpatient,
          medical_coordination_units: addings.outpatient ? ADDITION_UNITS.outpatient : 0,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error) throw error;
      toast.success("更新しました");
      fetchClaims();
    } catch (err: unknown) {
      toast.error(
        "更新に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    }
  };

  // ── CSV Export ────────────────────────────────────────────────────────────

  const handleCSVExport = () => {
    if (claims.length === 0) {
      toast.error("出力するデータがありません");
      return;
    }
    const confirmed = claims.filter((c) => c.status !== "draft");
    if (confirmed.length === 0) {
      toast.error("確定済みのレセプトがありません。確定後に出力してください。");
      return;
    }
    const csv = generateCSV(confirmed, billingMonth, certMap);
    const filename = `居宅介護支援_レセプト_${billingMonth.replace("-", "")}.csv`;
    downloadCSV(csv, filename);
    toast.success(`${confirmed.length}件のCSVを出力しました`);
  };

  // ── Row expand ────────────────────────────────────────────────────────────

  const toggleExpand = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Edit modal */}
      {editTarget && (
        <EditModal
          claim={editTarget}
          certEntry={certMap.get(editTarget.user_id)}
          onClose={() => setEditTarget(null)}
          onSave={handleEditSave}
        />
      )}

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FileText className="text-blue-600" size={24} />
          <h1 className="text-xl font-bold text-gray-900">
            居宅介護支援レセプト管理
          </h1>
          {!loading && (
            <span className="ml-1 rounded-full bg-gray-100 px-2.5 py-0.5 text-sm text-gray-600">
              {claims.length}件
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Billing month */}
          <input
            type="month"
            value={billingMonth}
            onChange={(e) => setBillingMonth(e.target.value)}
            className="rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />

          {/* Refresh */}
          <button
            onClick={fetchClaims}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            更新
          </button>

          {/* Generate */}
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition-colors disabled:opacity-50"
          >
            {generating ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Zap size={14} />
            )}
            一括生成
          </button>

          {/* Confirm all */}
          <button
            onClick={handleConfirmAll}
            disabled={confirmingAll || summary.draft === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 transition-colors disabled:opacity-50"
          >
            {confirmingAll ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <CheckCircle size={14} />
            )}
            全件確定
          </button>

          {/* CSV Export */}
          <button
            onClick={handleCSVExport}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            <Download size={14} />
            国保連CSV出力
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
            <Users size={13} className="text-indigo-500" />
            対象利用者数
          </div>
          <p className="text-2xl font-bold text-gray-900">{summary.total}名</p>
        </div>
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
            <Wallet size={13} className="text-blue-500" />
            請求総額
          </div>
          <p className="text-2xl font-bold text-gray-900">
            {formatAmount(summary.totalAmount)}
          </p>
        </div>
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
            <CheckCircle size={13} className="text-green-500" />
            確定済み
          </div>
          <p className="text-2xl font-bold text-green-700">
            {summary.confirmed}件
          </p>
        </div>
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
            <Clock size={13} className="text-yellow-500" />
            未確定
          </div>
          <p className="text-2xl font-bold text-yellow-700">{summary.draft}件</p>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 size={28} className="animate-spin text-blue-500" />
          </div>
        ) : claims.length === 0 ? (
          <div className="py-20 text-center text-sm text-gray-500">
            <FileText size={44} className="mx-auto mb-3 opacity-20" />
            <p className="font-medium">レセプトデータがありません</p>
            <p className="mt-1 text-xs text-gray-400">
              「一括生成」ボタンで{formatMonth(billingMonth)}分を自動生成できます
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 whitespace-nowrap">
                    利用者名
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 whitespace-nowrap">
                    被保険者番号
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 whitespace-nowrap">
                    要介護度
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 whitespace-nowrap">
                    サービスコード
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 whitespace-nowrap max-w-xs">
                    サービス名称
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600 whitespace-nowrap">
                    単位数
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600 whitespace-nowrap">
                    単価
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600 whitespace-nowrap">
                    費用合計
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600 whitespace-nowrap">
                    保険請求額
                  </th>
                  <th className="px-4 py-3 text-center font-medium text-gray-600 whitespace-nowrap">
                    加算
                  </th>
                  <th className="px-4 py-3 text-center font-medium text-gray-600 whitespace-nowrap">
                    ステータス
                  </th>
                  <th className="px-4 py-3 text-center font-medium text-gray-600 whitespace-nowrap">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {claims.map((claim) => {
                  const isExpanded = expandedRows.has(claim.id);
                  const additionLabels: string[] = [];
                  if (claim.initial_addition) additionLabels.push("初回");
                  if (claim.hospital_coordination) additionLabels.push("入院連携");
                  if (claim.discharge_addition) additionLabels.push("退院加算");
                  if (claim.medical_coordination) additionLabels.push("通院連携");
                  const additionUnitsSum =
                    (claim.initial_addition ? claim.initial_addition_units : 0) +
                    (claim.hospital_coordination ? claim.hospital_coordination_units : 0) +
                    (claim.discharge_addition ? claim.discharge_addition_units : 0) +
                    (claim.medical_coordination ? claim.medical_coordination_units : 0);
                  const certEntry = certMap.get(claim.user_id);

                  return (
                    <>
                      <tr
                        key={claim.id}
                        className="hover:bg-gray-50 transition-colors"
                      >
                        {/* 利用者名 */}
                        <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">
                          {claim.kaigo_users?.name ?? "—"}
                        </td>
                        {/* 被保険者番号 */}
                        <td className="px-4 py-3 text-gray-600 font-mono whitespace-nowrap">
                          {certEntry?.insured_number ?? "—"}
                        </td>
                        {/* 要介護度 */}
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span className="rounded-full bg-purple-50 px-2.5 py-0.5 text-xs font-medium text-purple-700">
                            {certEntry?.care_level ?? "—"}
                          </span>
                        </td>
                        {/* サービスコード */}
                        <td className="px-4 py-3 font-mono text-gray-700 whitespace-nowrap">
                          {claim.care_support_code}
                        </td>
                        {/* サービス名称 */}
                        <td className="px-4 py-3 text-gray-700 max-w-xs truncate">
                          {claim.care_support_name}
                        </td>
                        {/* 単位数 */}
                        <td className="px-4 py-3 text-right text-gray-800 whitespace-nowrap">
                          <span className="font-medium">
                            {(claim.units + additionUnitsSum).toLocaleString("ja-JP")}
                          </span>
                          {additionUnitsSum > 0 && (
                            <span className="ml-1 text-xs text-indigo-500">
                              (+{additionUnitsSum})
                            </span>
                          )}
                        </td>
                        {/* 単価 */}
                        <td className="px-4 py-3 text-right text-gray-600 whitespace-nowrap">
                          {claim.unit_price.toFixed(2)}
                        </td>
                        {/* 費用合計 */}
                        <td className="px-4 py-3 text-right font-medium text-gray-900 whitespace-nowrap">
                          {formatAmount(claim.total_amount)}
                        </td>
                        {/* 保険請求額 */}
                        <td className="px-4 py-3 text-right font-medium text-blue-700 whitespace-nowrap">
                          {formatAmount(claim.insurance_amount)}
                        </td>
                        {/* 加算 */}
                        <td className="px-4 py-3 text-center">
                          {additionLabels.length > 0 ? (
                            <button
                              onClick={() => toggleExpand(claim.id)}
                              className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700 hover:bg-indigo-100"
                            >
                              {additionLabels.length}件
                              {isExpanded ? (
                                <ChevronUp size={11} />
                              ) : (
                                <ChevronDown size={11} />
                              )}
                            </button>
                          ) : (
                            <span className="text-xs text-gray-300">なし</span>
                          )}
                        </td>
                        {/* ステータス */}
                        <td className="px-4 py-3 text-center whitespace-nowrap">
                          <span
                            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[claim.status]}`}
                          >
                            {STATUS_LABELS[claim.status]}
                          </span>
                        </td>
                        {/* 操作 */}
                        <td className="px-4 py-3 text-center whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            {/* Edit */}
                            <button
                              onClick={() => setEditTarget(claim)}
                              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors"
                              title="編集"
                            >
                              <Pencil size={14} />
                            </button>
                            {/* Confirm / Cancel */}
                            {claim.status === "draft" ? (
                              <button
                                onClick={() =>
                                  handleSetStatus(claim.id, "confirmed")
                                }
                                className="rounded p-1 text-green-500 hover:bg-green-50 hover:text-green-700 transition-colors"
                                title="確定"
                              >
                                <Check size={14} />
                              </button>
                            ) : claim.status === "confirmed" ? (
                              <button
                                onClick={() =>
                                  handleSetStatus(claim.id, "draft")
                                }
                                className="rounded p-1 text-yellow-500 hover:bg-yellow-50 hover:text-yellow-700 transition-colors"
                                title="取消（下書きに戻す）"
                              >
                                <X size={14} />
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>

                      {/* Expanded addition detail */}
                      {isExpanded && additionLabels.length > 0 && (
                        <tr key={`${claim.id}-expand`} className="bg-indigo-50/40">
                          <td colSpan={12} className="px-8 py-2">
                            <div className="flex flex-wrap gap-2 text-xs text-indigo-700">
                              {claim.initial_addition && (
                                <span className="rounded border border-indigo-200 bg-white px-2 py-0.5">
                                  初回加算 +{claim.initial_addition_units}単位
                                </span>
                              )}
                              {claim.hospital_coordination && (
                                <span className="rounded border border-indigo-200 bg-white px-2 py-0.5">
                                  入院時情報連携加算 +{claim.hospital_coordination_units}単位
                                </span>
                              )}
                              {claim.discharge_addition && (
                                <span className="rounded border border-indigo-200 bg-white px-2 py-0.5">
                                  退院・退所加算 +{claim.discharge_addition_units}単位
                                </span>
                              )}
                              {claim.medical_coordination && (
                                <span className="rounded border border-indigo-200 bg-white px-2 py-0.5">
                                  通院時情報連携加算 +{claim.medical_coordination_units}単位
                                </span>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>

              {/* Footer totals */}
              {claims.length > 0 && (
                <tfoot className="border-t bg-gray-50">
                  <tr>
                    <td
                      colSpan={7}
                      className="px-4 py-3 text-sm font-medium text-gray-600"
                    >
                      合計 ({claims.length}件)
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-bold text-gray-900 whitespace-nowrap">
                      {formatAmount(
                        claims.reduce((s, c) => s + c.total_amount, 0)
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-bold text-blue-700 whitespace-nowrap">
                      {formatAmount(
                        claims.reduce((s, c) => s + c.insurance_amount, 0)
                      )}
                    </td>
                    <td colSpan={3} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>

      {/* Footer note */}
      <p className="text-xs text-gray-400">
        ※ 居宅介護支援費は10割給付のため利用者負担額は0円です。国保連CSV出力は確定済みレセプトのみ対象です。
      </p>
    </div>
  );
}
