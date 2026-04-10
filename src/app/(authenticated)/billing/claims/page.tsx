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

type TokuteiKassanType = "none" | "Ⅰ" | "Ⅱ" | "Ⅲ" | "A";

// 旧形式 (A/B/C) や事業所設定の "なし" を新形式にマッピング
function normalizeTokuteiKassan(v: string | null | undefined): TokuteiKassanType {
  if (!v) return "none";
  const s = String(v);
  if (s === "なし" || s === "none") return "none";
  if (s === "Ⅰ" || s === "Ⅱ" || s === "Ⅲ") return s;
  // 旧形式（令和3年度）のマッピング: 旧A/B/C → 新Ⅰ/Ⅱ/Ⅲ
  if (s === "B") return "Ⅱ";
  if (s === "C") return "Ⅲ";
  // 新区分"A"（令和6年度新設114単位）か旧"A"(505単位)かは文脈不明だが、
  // 新区分として扱う（ユーザーは設定画面で編集可能）
  if (s === "A") return "A";
  return "none";
}
type HospitalCoordType = "none" | "i" | "ii";
type DischargeType = "none" | "i_i" | "i_ro" | "ii_i" | "ii_ro" | "iii";

interface Addings {
  // 加算
  initial: boolean;                      // 初回加算 300単位
  tokutei_kassan: TokuteiKassanType;     // 特定事業所加算
  medical_coop_kassan: boolean;          // 特定事業所医療介護連携加算 125単位
  hospitalization: HospitalCoordType;   // 入院時情報連携加算
  discharge: DischargeType;             // 退院・退所加算
  outpatient: boolean;                  // 通院時情報連携加算 50単位
  terminal_care: boolean;               // ターミナルケアマネジメント加算 400単位
  emergency_conference: boolean;        // 緊急時等居宅カンファレンス加算 200単位/回
  // 減算
  bcp_not_prepared: boolean;            // 業務継続計画未策定減算
  abuse_prevention_not_implemented: boolean; // 高齢者虐待防止措置未実施減算
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
  // existing addition columns
  initial_addition: boolean;
  initial_addition_units: number;
  hospital_coordination: boolean;
  hospital_coordination_units: number;
  discharge_addition: boolean;
  discharge_addition_units: number;
  medical_coordination: boolean;
  medical_coordination_units: number;
  // new columns (migration 008)
  tokutei_kassan_type: TokuteiKassanType | null;
  tokutei_kassan_units: number;
  medical_coop_kassan: boolean;
  medical_coop_kassan_units: number;
  discharge_type: DischargeType | null;
  terminal_care: boolean;
  terminal_care_units: number;
  emergency_conference: boolean;
  emergency_conference_units: number;
  bcp_not_prepared: boolean;
  bcp_reduction_pct: number;
  abuse_prevention_not_implemented: boolean;
  abuse_reduction_pct: number;
  status: ClaimStatus;
  notes: string | null;
  kaigo_users?: { name: string };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// 年度別単位数テーブル（kaigo_care_support_rates）から取得。フォールバック用の静的マップ。
const CARE_LEVEL_MAP_FALLBACK: Record<
  string,
  { units: number; code: string; name: string }
> = {
  要支援1: { units: 443, code: "461000", name: "介護予防支援費" },
  要支援2: { units: 443, code: "461000", name: "介護予防支援費" },
  要介護1: { units: 1086, code: "432301", name: "居宅介護支援費Ⅰⅰ１" },
  要介護2: { units: 1086, code: "432301", name: "居宅介護支援費Ⅰⅰ１" },
  要介護3: { units: 1411, code: "432271", name: "居宅介護支援費Ⅰⅰ２" },
  要介護4: { units: 1411, code: "432271", name: "居宅介護支援費Ⅰⅰ２" },
  要介護5: { units: 1411, code: "432271", name: "居宅介護支援費Ⅰⅰ２" },
};

type CareLevelInfo = { units: number; code: string; name: string };

function getFiscalYear(billingMonth: string): string {
  const [y, m] = billingMonth.split("-").map(Number);
  return m >= 4 ? String(y) : String(y - 1);
}

// 令和6年度改定 居宅介護支援 特定事業所加算単位数（フォールバック）
// 本来は kaigo_tokutei_kassan_rates テーブルから取得
const TOKUTEI_KASSAN_UNITS_FALLBACK: Record<string, number> = {
  none: 0,
  "Ⅰ": 519,
  "Ⅱ": 421,
  "Ⅲ": 323,
  A: 114,
  // 旧区分も残す（既存データ対応）
  B: 421,
  C: 323,
};

// 実際の単位数（一括生成時にDBから読み込み後に上書き）
const TOKUTEI_KASSAN_UNITS: Record<string, number> = { ...TOKUTEI_KASSAN_UNITS_FALLBACK };

const HOSPITAL_COORD_UNITS: Record<HospitalCoordType, number> = {
  none: 0,
  i: 250,
  ii: 200,
};

const DISCHARGE_UNITS: Record<DischargeType, number> = {
  none: 0,
  i_i: 450,
  i_ro: 600,
  ii_i: 600,
  ii_ro: 750,
  iii: 900,
};

const DISCHARGE_LABELS: Record<DischargeType, string> = {
  none: "なし",
  i_i: "(i)イ 450単位",
  i_ro: "(i)ロ 600単位",
  ii_i: "(ii)イ 600単位",
  ii_ro: "(ii)ロ 750単位",
  iii: "(iii) 900単位",
};

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
    (addings.initial ? 300 : 0) +
    TOKUTEI_KASSAN_UNITS[addings.tokutei_kassan] +
    (addings.medical_coop_kassan ? 125 : 0) +
    HOSPITAL_COORD_UNITS[addings.hospitalization] +
    DISCHARGE_UNITS[addings.discharge] +
    (addings.outpatient ? 50 : 0) +
    (addings.terminal_care ? 400 : 0) +
    (addings.emergency_conference ? 200 : 0)
  );
}

function calcReductionUnits(baseUnits: number, addings: Addings): number {
  // Each reduction is floor(baseUnits * 1%)
  const bcpRed = addings.bcp_not_prepared ? Math.floor(baseUnits * 1 / 100) : 0;
  const abuseRed = addings.abuse_prevention_not_implemented ? Math.floor(baseUnits * 1 / 100) : 0;
  return bcpRed + abuseRed;
}

function calcTotals(
  baseUnits: number,
  addUnits: number,
  reductionUnits: number,
  unitPrice: number
): { total_units: number; total_amount: number; insurance_amount: number } {
  const total_units = baseUnits + addUnits - reductionUnits;
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
      "基本単位数",
      "加算単位数",
      "減算単位数",
      "合計単位数",
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
      (c.medical_coordination ? c.medical_coordination_units : 0) +
      (c.tokutei_kassan_units ?? 0) +
      (c.medical_coop_kassan ? (c.medical_coop_kassan_units ?? 125) : 0) +
      (c.terminal_care ? (c.terminal_care_units ?? 400) : 0) +
      (c.emergency_conference ? (c.emergency_conference_units ?? 200) : 0);
    const reductionUnitsSum =
      (c.bcp_not_prepared ? Math.floor(c.units * (c.bcp_reduction_pct ?? 1) / 100) : 0) +
      (c.abuse_prevention_not_implemented ? Math.floor(c.units * (c.abuse_reduction_pct ?? 1) / 100) : 0);
    const row = [
      "明細",
      billingMonth.replace("-", ""),
      cert?.insurer_number ?? "",
      cert?.insured_number ?? "",
      "43", // 居宅介護支援
      c.care_support_code,
      c.units,
      additionUnitsSum,
      reductionUnitsSum,
      c.units + additionUnitsSum - reductionUnitsSum,
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
  const supabase = createClient();

  const [addings, setAddings] = useState<Addings>({
    initial: claim.initial_addition,
    tokutei_kassan: normalizeTokuteiKassan(claim.tokutei_kassan_type as string | null),
    medical_coop_kassan: claim.medical_coop_kassan ?? false,
    hospitalization: (() => {
      if (!claim.hospital_coordination) return "none";
      return claim.hospital_coordination_units >= 250 ? "i" : "ii";
    })() as HospitalCoordType,
    discharge: (claim.discharge_type as DischargeType) ?? (claim.discharge_addition ? "i_ro" : "none"),
    outpatient: claim.medical_coordination,
    terminal_care: claim.terminal_care ?? false,
    emergency_conference: claim.emergency_conference ?? false,
    bcp_not_prepared: claim.bcp_not_prepared ?? false,
    abuse_prevention_not_implemented: claim.abuse_prevention_not_implemented ?? false,
  });
  const [unitPrice, setUnitPrice] = useState(claim.unit_price);
  const [saving, setSaving] = useState(false);

  // Auto-fill tokutei_kassan and medical_coop_kassan from office settings
  useEffect(() => {
    supabase
      .from("kaigo_office_settings")
      .select("tokutei_kassan_type, medical_cooperation_kassan")
      .limit(1)
      .maybeSingle()
      .then(({ data }: { data: Record<string, unknown> | null }) => {
        if (!data) return;
        setAddings((prev) => ({
          ...prev,
          tokutei_kassan: data.tokutei_kassan_type ? normalizeTokuteiKassan(String(data.tokutei_kassan_type)) : prev.tokutei_kassan,
          medical_coop_kassan: (data.medical_cooperation_kassan as boolean | null) ?? prev.medical_coop_kassan,
        }));
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addUnits = calcAdditionUnits(addings);
  const reductionUnits = calcReductionUnits(claim.units, addings);
  const { total_units, total_amount } = calcTotals(
    claim.units,
    addUnits,
    reductionUnits,
    unitPrice
  );

  const toggleBool = (key: keyof Addings) =>
    setAddings((prev) => ({ ...prev, [key]: !prev[key] }));

  const handleSave = async () => {
    setSaving(true);
    await onSave(claim.id, addings, unitPrice);
    setSaving(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-xl border bg-white shadow-xl p-6 space-y-5 max-h-[90vh] overflow-y-auto">
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
          <p className="text-xs font-semibold text-gray-500 uppercase mb-2 tracking-wide">加算</p>
          <div className="space-y-2">

            {/* 1. 初回加算 */}
            <label className="flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors">
              <input
                type="checkbox"
                checked={addings.initial}
                onChange={() => toggleBool("initial")}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="flex-1 text-sm text-gray-700">初回加算</span>
              <span className="text-xs text-gray-400">+300単位</span>
            </label>

            {/* 2. 特定事業所加算 */}
            <div className="flex items-center gap-3 rounded-lg border px-3 py-2">
              <span className="flex-1 text-sm text-gray-700">特定事業所加算</span>
              <select
                value={addings.tokutei_kassan}
                onChange={(e) =>
                  setAddings((prev) => ({
                    ...prev,
                    tokutei_kassan: e.target.value as TokuteiKassanType,
                  }))
                }
                className="rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="none">なし</option>
                <option value="Ⅰ">Ⅰ (+{TOKUTEI_KASSAN_UNITS["Ⅰ"] ?? 519}単位)</option>
                <option value="Ⅱ">Ⅱ (+{TOKUTEI_KASSAN_UNITS["Ⅱ"] ?? 421}単位)</option>
                <option value="Ⅲ">Ⅲ (+{TOKUTEI_KASSAN_UNITS["Ⅲ"] ?? 323}単位)</option>
                <option value="A">A (+{TOKUTEI_KASSAN_UNITS["A"] ?? 114}単位)</option>
              </select>
            </div>

            {/* 3. 特定事業所医療介護連携加算 */}
            <label className="flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors">
              <input
                type="checkbox"
                checked={addings.medical_coop_kassan}
                onChange={() => toggleBool("medical_coop_kassan")}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="flex-1 text-sm text-gray-700">特定事業所医療介護連携加算</span>
              <span className="text-xs text-gray-400">+125単位</span>
            </label>

            {/* 4. 入院時情報連携加算 */}
            <div className="flex items-center gap-3 rounded-lg border px-3 py-2">
              <span className="flex-1 text-sm text-gray-700">入院時情報連携加算</span>
              <select
                value={addings.hospitalization}
                onChange={(e) =>
                  setAddings((prev) => ({
                    ...prev,
                    hospitalization: e.target.value as HospitalCoordType,
                  }))
                }
                className="rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="none">なし</option>
                <option value="i">(i) +250単位</option>
                <option value="ii">(ii) +200単位</option>
              </select>
            </div>

            {/* 5. 退院・退所加算 */}
            <div className="flex items-center gap-3 rounded-lg border px-3 py-2">
              <span className="flex-1 text-sm text-gray-700">退院・退所加算</span>
              <select
                value={addings.discharge}
                onChange={(e) =>
                  setAddings((prev) => ({
                    ...prev,
                    discharge: e.target.value as DischargeType,
                  }))
                }
                className="rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {(Object.keys(DISCHARGE_LABELS) as DischargeType[]).map((k) => (
                  <option key={k} value={k}>{DISCHARGE_LABELS[k]}</option>
                ))}
              </select>
            </div>

            {/* 6. 通院時情報連携加算 */}
            <label className="flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors">
              <input
                type="checkbox"
                checked={addings.outpatient}
                onChange={() => toggleBool("outpatient")}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="flex-1 text-sm text-gray-700">通院時情報連携加算</span>
              <span className="text-xs text-gray-400">+50単位</span>
            </label>

            {/* 7. ターミナルケアマネジメント加算 */}
            <label className="flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors">
              <input
                type="checkbox"
                checked={addings.terminal_care}
                onChange={() => toggleBool("terminal_care")}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="flex-1 text-sm text-gray-700">ターミナルケアマネジメント加算</span>
              <span className="text-xs text-gray-400">+400単位</span>
            </label>

            {/* 8. 緊急時等居宅カンファレンス加算 */}
            <label className="flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors">
              <input
                type="checkbox"
                checked={addings.emergency_conference}
                onChange={() => toggleBool("emergency_conference")}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="flex-1 text-sm text-gray-700">緊急時等居宅カンファレンス加算</span>
              <span className="text-xs text-gray-400">+200単位/回</span>
            </label>
          </div>
        </div>

        {/* Reductions */}
        <div>
          <p className="text-xs font-semibold text-red-500 uppercase mb-2 tracking-wide">減算</p>
          <div className="space-y-2">

            {/* 9. 業務継続計画未策定減算 */}
            <label className="flex items-center gap-3 rounded-lg border border-red-100 px-3 py-2 cursor-pointer hover:bg-red-50 transition-colors">
              <input
                type="checkbox"
                checked={addings.bcp_not_prepared}
                onChange={() => toggleBool("bcp_not_prepared")}
                className="rounded border-gray-300 text-red-500 focus:ring-red-400"
              />
              <span className="flex-1 text-sm text-gray-700">業務継続計画未策定減算</span>
              <span className="text-xs text-red-400">所定単位数×1%減</span>
            </label>

            {/* 10. 高齢者虐待防止措置未実施減算 */}
            <label className="flex items-center gap-3 rounded-lg border border-red-100 px-3 py-2 cursor-pointer hover:bg-red-50 transition-colors">
              <input
                type="checkbox"
                checked={addings.abuse_prevention_not_implemented}
                onChange={() => toggleBool("abuse_prevention_not_implemented")}
                className="rounded border-gray-300 text-red-500 focus:ring-red-400"
              />
              <span className="flex-1 text-sm text-gray-700">高齢者虐待防止措置未実施減算</span>
              <span className="text-xs text-red-400">所定単位数×1%減</span>
            </label>
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
            <span className="text-indigo-600">+{addUnits.toLocaleString("ja-JP")} 単位</span>
          </div>
          {reductionUnits > 0 && (
            <div className="flex justify-between text-gray-600">
              <span>減算単位合計</span>
              <span className="text-red-500">−{reductionUnits.toLocaleString("ja-JP")} 単位</span>
            </div>
          )}
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
          (err instanceof Error ? err.message : typeof err === "object" && err !== null && "message" in err ? String((err as any).message) : JSON.stringify(err))
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

      // 4. Fetch office settings for auto-apply
      const { data: officeSettings } = await supabase
        .from("kaigo_office_settings")
        .select("tokutei_kassan_type, medical_cooperation_kassan")
        .limit(1)
        .maybeSingle();

      // 5. Fetch fiscal year rates from DB
      const fy = getFiscalYear(billingMonth);
      const [ratesRes, tkRatesRes] = await Promise.all([
        supabase
          .from("kaigo_care_support_rates")
          .select("care_level, units, service_code, service_name")
          .eq("fiscal_year", fy),
        supabase
          .from("kaigo_tokutei_kassan_rates")
          .select("kassan_type, units")
          .eq("fiscal_year", fy)
          .eq("business_type", "居宅介護支援"),
      ]);

      const CARE_LEVEL_MAP: Record<string, CareLevelInfo> = { ...CARE_LEVEL_MAP_FALLBACK };
      if (ratesRes.data && ratesRes.data.length > 0) {
        for (const r of ratesRes.data) {
          CARE_LEVEL_MAP[r.care_level] = {
            units: r.units,
            code: r.service_code,
            name: r.service_name,
          };
        }
      }

      // 特定事業所加算単位数をDBから上書き
      if (tkRatesRes.data && tkRatesRes.data.length > 0) {
        for (const r of tkRatesRes.data) {
          TOKUTEI_KASSAN_UNITS[r.kassan_type] = r.units;
        }
      }

      // 事業所設定は "なし"/"Ⅰ"/"Ⅱ"/"Ⅲ"/"A"、レセプトは "none"/"Ⅰ"/"Ⅱ"/"Ⅲ"/"A"
      const officeTokutei: TokuteiKassanType = normalizeTokuteiKassan(officeSettings?.tokutei_kassan_type);
      const officeMedicalCoop = officeSettings?.medical_cooperation_kassan ?? false;
      const officeTokuteiUnits = TOKUTEI_KASSAN_UNITS[officeTokutei] ?? 0;
      const officeMedicalCoopUnits = officeMedicalCoop ? 125 : 0;

      // 6. Delete existing claims for this month
      await supabase
        .from("kaigo_care_support_claims")
        .delete()
        .eq("billing_month", billingMonth);

      // 7. Build insert rows
      const now = new Date().toISOString();
      const rows: Record<string, unknown>[] = [];

      for (const user of users as { id: string; name: string }[]) {
        if (!activeUserIds.has(user.id)) continue;
        const cert = certMap.get(user.id);
        if (!cert) continue;

        const levelInfo = CARE_LEVEL_MAP[cert.care_level];
        if (!levelInfo) continue;

        const autoAddUnits = officeTokuteiUnits + officeMedicalCoopUnits;
        const { total_amount } = calcTotals(levelInfo.units, autoAddUnits, 0, 10);

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
          tokutei_kassan_type: officeTokutei === "none" ? null : officeTokutei,
          tokutei_kassan_units: officeTokuteiUnits,
          medical_coop_kassan: officeMedicalCoop,
          medical_coop_kassan_units: officeMedicalCoopUnits,
          discharge_type: null,
          terminal_care: false,
          terminal_care_units: 0,
          emergency_conference: false,
          emergency_conference_units: 0,
          bcp_not_prepared: false,
          bcp_reduction_pct: 0,
          abuse_prevention_not_implemented: false,
          abuse_reduction_pct: 0,
          status: "draft",
          created_at: now,
        });
      }

      if (rows.length === 0) {
        toast.error("生成できるレセプトデータがありませんでした");
        return;
      }

      let { error: insertErr } = await supabase
        .from("kaigo_care_support_claims")
        .insert(rows);

      if (insertErr) {
        // マイグレーション008が未適用の可能性 — エラーメッセージを表示してSQL案内
        console.error("Insert failed:", insertErr);
        toast.error(
          "レセプト生成に失敗しました。Supabaseで以下のマイグレーションを実行してください: supabase/migrations/008_kassan_expansion.sql"
        );
        throw insertErr;
      }

      toast.success(
        `${formatMonth(billingMonth)}のレセプトを${rows.length}件生成しました`
      );
      fetchClaims();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message
        : typeof err === "object" && err !== null && "message" in err ? String((err as any).message)
        : JSON.stringify(err);
      toast.error("一括生成に失敗しました: " + msg);
      console.error("一括生成エラー:", err);
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
          (err instanceof Error ? err.message : typeof err === "object" && err !== null && "message" in err ? String((err as any).message) : JSON.stringify(err))
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
          (err instanceof Error ? err.message : typeof err === "object" && err !== null && "message" in err ? String((err as any).message) : JSON.stringify(err))
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
    const reductionUnits = calcReductionUnits(claim.units, addings);
    const { total_amount, insurance_amount } = calcTotals(
      claim.units,
      addUnits,
      reductionUnits,
      unitPrice
    );

    try {
      const { error } = await supabase
        .from("kaigo_care_support_claims")
        .update({
          unit_price: unitPrice,
          total_amount,
          insurance_amount,
          // existing columns
          initial_addition: addings.initial,
          initial_addition_units: addings.initial ? 300 : 0,
          hospital_coordination: addings.hospitalization !== "none",
          hospital_coordination_units: HOSPITAL_COORD_UNITS[addings.hospitalization],
          discharge_addition: addings.discharge !== "none",
          discharge_addition_units: DISCHARGE_UNITS[addings.discharge],
          medical_coordination: addings.outpatient,
          medical_coordination_units: addings.outpatient ? 50 : 0,
          // new columns
          tokutei_kassan_type: addings.tokutei_kassan === "none" ? null : addings.tokutei_kassan,
          tokutei_kassan_units: TOKUTEI_KASSAN_UNITS[addings.tokutei_kassan],
          medical_coop_kassan: addings.medical_coop_kassan,
          medical_coop_kassan_units: addings.medical_coop_kassan ? 125 : 0,
          discharge_type: addings.discharge === "none" ? null : addings.discharge,
          terminal_care: addings.terminal_care,
          terminal_care_units: addings.terminal_care ? 400 : 0,
          emergency_conference: addings.emergency_conference,
          emergency_conference_units: addings.emergency_conference ? 200 : 0,
          bcp_not_prepared: addings.bcp_not_prepared,
          bcp_reduction_pct: addings.bcp_not_prepared ? 1 : 0,
          abuse_prevention_not_implemented: addings.abuse_prevention_not_implemented,
          abuse_reduction_pct: addings.abuse_prevention_not_implemented ? 1 : 0,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error) throw error;
      toast.success("更新しました");
      fetchClaims();
    } catch (err: unknown) {
      toast.error(
        "更新に失敗しました: " +
          (err instanceof Error ? err.message : typeof err === "object" && err !== null && "message" in err ? String((err as any).message) : JSON.stringify(err))
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
                  if (claim.tokutei_kassan_type && String(claim.tokutei_kassan_type) !== "none" && String(claim.tokutei_kassan_type) !== "なし") additionLabels.push(`特定${claim.tokutei_kassan_type}`);
                  if (claim.medical_coop_kassan) additionLabels.push("医療連携");
                  if (claim.hospital_coordination) additionLabels.push("入院連携");
                  if (claim.discharge_addition) additionLabels.push("退院加算");
                  if (claim.medical_coordination) additionLabels.push("通院連携");
                  if (claim.terminal_care) additionLabels.push("ターミナル");
                  if (claim.emergency_conference) additionLabels.push("緊急会議");
                  const hasReduction = (claim.bcp_not_prepared || claim.abuse_prevention_not_implemented);
                  const additionUnitsSum =
                    (claim.initial_addition ? claim.initial_addition_units : 0) +
                    (claim.tokutei_kassan_units ?? 0) +
                    (claim.medical_coop_kassan ? (claim.medical_coop_kassan_units ?? 125) : 0) +
                    (claim.hospital_coordination ? claim.hospital_coordination_units : 0) +
                    (claim.discharge_addition ? claim.discharge_addition_units : 0) +
                    (claim.medical_coordination ? claim.medical_coordination_units : 0) +
                    (claim.terminal_care ? (claim.terminal_care_units ?? 400) : 0) +
                    (claim.emergency_conference ? (claim.emergency_conference_units ?? 200) : 0);
                  const reductionUnitsSum =
                    (claim.bcp_not_prepared ? Math.floor(claim.units * (claim.bcp_reduction_pct ?? 1) / 100) : 0) +
                    (claim.abuse_prevention_not_implemented ? Math.floor(claim.units * (claim.abuse_reduction_pct ?? 1) / 100) : 0);
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
                          <span className="font-bold">{claim.units.toLocaleString("ja-JP")}</span>
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
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          {additionUnitsSum > 0 ? (
                            <span className="text-xs font-medium text-indigo-600">+{additionUnitsSum.toLocaleString()}</span>
                          ) : reductionUnitsSum > 0 ? (
                            <span className="text-xs font-medium text-red-500">−{reductionUnitsSum}</span>
                          ) : (
                            <span className="text-xs text-gray-300">—</span>
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

                      {/* 加算行（各加算を個別の行で表示） */}
                      {(claim.tokutei_kassan_units ?? 0) > 0 && (
                        <tr key={`${claim.id}-tokutei`} className="bg-indigo-50/30">
                          <td colSpan={5} className="px-4 py-1.5 text-xs text-indigo-700 pl-12">
                            ┗ 特定事業所加算({claim.tokutei_kassan_type})
                          </td>
                          <td className="px-4 py-1.5 text-right text-xs font-medium text-indigo-700">+{claim.tokutei_kassan_units}</td>
                          <td colSpan={6}></td>
                        </tr>
                      )}
                      {claim.medical_coop_kassan && (
                        <tr key={`${claim.id}-medcoop`} className="bg-indigo-50/30">
                          <td colSpan={5} className="px-4 py-1.5 text-xs text-indigo-700 pl-12">
                            ┗ 特定事業所医療介護連携加算
                          </td>
                          <td className="px-4 py-1.5 text-right text-xs font-medium text-indigo-700">+{claim.medical_coop_kassan_units ?? 125}</td>
                          <td colSpan={6}></td>
                        </tr>
                      )}
                      {claim.initial_addition && (
                        <tr key={`${claim.id}-initial`} className="bg-indigo-50/30">
                          <td colSpan={5} className="px-4 py-1.5 text-xs text-indigo-700 pl-12">
                            ┗ 初回加算
                          </td>
                          <td className="px-4 py-1.5 text-right text-xs font-medium text-indigo-700">+{claim.initial_addition_units}</td>
                          <td colSpan={6}></td>
                        </tr>
                      )}
                      {claim.hospital_coordination && (
                        <tr key={`${claim.id}-hospital`} className="bg-indigo-50/30">
                          <td colSpan={5} className="px-4 py-1.5 text-xs text-indigo-700 pl-12">
                            ┗ 入院時情報連携加算
                          </td>
                          <td className="px-4 py-1.5 text-right text-xs font-medium text-indigo-700">+{claim.hospital_coordination_units}</td>
                          <td colSpan={6}></td>
                        </tr>
                      )}
                      {claim.discharge_addition && (
                        <tr key={`${claim.id}-discharge`} className="bg-indigo-50/30">
                          <td colSpan={5} className="px-4 py-1.5 text-xs text-indigo-700 pl-12">
                            ┗ 退院・退所加算{claim.discharge_type ? `(${DISCHARGE_LABELS[claim.discharge_type as DischargeType]})` : ""}
                          </td>
                          <td className="px-4 py-1.5 text-right text-xs font-medium text-indigo-700">+{claim.discharge_addition_units}</td>
                          <td colSpan={6}></td>
                        </tr>
                      )}
                      {claim.medical_coordination && (
                        <tr key={`${claim.id}-outpatient`} className="bg-indigo-50/30">
                          <td colSpan={5} className="px-4 py-1.5 text-xs text-indigo-700 pl-12">
                            ┗ 通院時情報連携加算
                          </td>
                          <td className="px-4 py-1.5 text-right text-xs font-medium text-indigo-700">+{claim.medical_coordination_units}</td>
                          <td colSpan={6}></td>
                        </tr>
                      )}
                      {claim.terminal_care && (
                        <tr key={`${claim.id}-terminal`} className="bg-indigo-50/30">
                          <td colSpan={5} className="px-4 py-1.5 text-xs text-indigo-700 pl-12">
                            ┗ ターミナルケアマネジメント加算
                          </td>
                          <td className="px-4 py-1.5 text-right text-xs font-medium text-indigo-700">+{claim.terminal_care_units ?? 400}</td>
                          <td colSpan={6}></td>
                        </tr>
                      )}
                      {claim.emergency_conference && (
                        <tr key={`${claim.id}-emergency`} className="bg-indigo-50/30">
                          <td colSpan={5} className="px-4 py-1.5 text-xs text-indigo-700 pl-12">
                            ┗ 緊急時等居宅カンファレンス加算
                          </td>
                          <td className="px-4 py-1.5 text-right text-xs font-medium text-indigo-700">+{claim.emergency_conference_units ?? 200}</td>
                          <td colSpan={6}></td>
                        </tr>
                      )}
                      {claim.bcp_not_prepared && (
                        <tr key={`${claim.id}-bcp`} className="bg-red-50/30">
                          <td colSpan={5} className="px-4 py-1.5 text-xs text-red-600 pl-12">
                            ┗ 業務継続計画未策定減算
                          </td>
                          <td className="px-4 py-1.5 text-right text-xs font-medium text-red-600">−{Math.floor(claim.units * (claim.bcp_reduction_pct ?? 1) / 100)}</td>
                          <td colSpan={6}></td>
                        </tr>
                      )}
                      {claim.abuse_prevention_not_implemented && (
                        <tr key={`${claim.id}-abuse`} className="bg-red-50/30">
                          <td colSpan={5} className="px-4 py-1.5 text-xs text-red-600 pl-12">
                            ┗ 虐待防止措置未実施減算
                          </td>
                          <td className="px-4 py-1.5 text-right text-xs font-medium text-red-600">−{Math.floor(claim.units * (claim.abuse_reduction_pct ?? 1) / 100)}</td>
                          <td colSpan={6}></td>
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
