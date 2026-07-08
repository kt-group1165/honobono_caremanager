"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
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
  Save,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
  ChevronUp,
} from "lucide-react";
import {
  type ClaimStatus,
  type TokuteiKassanType,
  type HospitalCoordType,
  type DischargeType,
  type ClaimRow,
  type CertMapEntry,
  type ClaimsOfficeInfo,
  ADDON_CODE_TO_DISCHARGE_TYPE,
  ADDON_CODE_TO_HOSPITAL_TYPE,
  ADDON_CODE_TO_TOKUTEI,
  AUTO_ADDON_NOTES_MARKER,
  KYOTAKU_ADDON_LAW_UNITS,
  type YoboShienKubun,
  YOBO_SHIEN_MARKER,
  getUnitPriceByArea,
  isAddonActiveInMonth,
  isYoboShienLevel,
  parseYoboShienKubun,
  setYoboShienMarker,
} from "./claims-shared";
import { validInMonth } from "@/lib/service-code-valid";
import { useBusinessType } from "@/lib/business-type-context";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ClaimRow / CertMapEntry / ClaimsOfficeInfo / getCurrentMonth は
// claims-shared.ts (server / client 共有 module) から import。

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// 年度別単位数テーブル（kaigo_care_support_rates）から取得。フォールバック用の静的マップ。
const CARE_LEVEL_MAP_FALLBACK: Record<
  string,
  { units: number; code: string; name: string }
> = {
  // 要支援は原則 kaigo_service_codes (対象月有効世代) から引く。ここは最終 fallback
  // (R6.4 世代の 介護予防支援費Ⅱ = 居宅介護支援事業所の直接指定 472 単位)。
  要支援1: { units: 472, code: "461112", name: "介護予防支援費Ⅱ (居宅介護支援事業所)" },
  要支援2: { units: 472, code: "461112", name: "介護予防支援費Ⅱ (居宅介護支援事業所)" },
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

// ─────────────────────────────────────────────────────────────────────────
// 介護予防支援費のサービスコード (46xx) を kaigo_service_codes から
// 対象月に有効な世代 (validInMonth) で引く。
// 実在コード (2026-07 時点の DB 確認済):
//   R6.4〜R8.5 世代: 461111 介護予防支援費Ⅰ(地域包括支援センター) 442 単位
//                    461112 介護予防支援費Ⅱ(居宅介護支援事業所)   472 単位
//   R8.6〜   世代: 462111 介護予防支援Ⅰ 442 単位 / 462121 介護予防支援Ⅱ 472 単位
//                  (地・山・小 や 虐防/業未 減算は名称に「・」を含む別コード)
// ─────────────────────────────────────────────────────────────────────────
type YoboShienCodes = { I: CareLevelInfo | null; II: CareLevelInfo | null };

async function fetchYoboShienCodes(
  supabase: ReturnType<typeof createClient>,
  billingMonth: string,
): Promise<YoboShienCodes> {
  const [y, m] = billingMonth.split("-").map(Number);
  const { data, error } = await validInMonth(
    supabase
      .from("kaigo_service_codes")
      .select("service_code, service_name, units, valid_from")
      .like("service_code", "46%")
      .eq("system", "介護")
      .eq("calculation_type", "基本"),
    y,
    m,
  );
  if (error) throw new Error(`介護予防支援費コード取得失敗: ${error.message}`);
  type Row = { service_code: string; service_name: string; units: number; valid_from: string | null };
  // 「・」付き (地域区分/減算 variant) を除いた素の基本コードのみ採用
  const base = ((data ?? []) as Row[]).filter(
    (r) => r.service_name.startsWith("介護予防支援") && !r.service_name.includes("・"),
  );
  const pick = (mark: "Ⅰ" | "Ⅱ"): CareLevelInfo | null => {
    const cands = base
      .filter((r) => r.service_name.includes(mark))
      .sort((a, b) => (b.valid_from ?? "").localeCompare(a.valid_from ?? ""));
    const c = cands[0];
    return c ? { units: c.units, code: c.service_code, name: c.service_name } : null;
  };
  return { I: pick("Ⅰ"), II: pick("Ⅱ") };
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

// chunked array helper: 大量 UUID を .in() に渡すと URI Too Long (HTTP 414) になり、
// Supabase JS は空 error message で reject → ブラウザ側で "Failed to fetch" と化けるため
// chunk 化して complain しない範囲で並列 fetch する。
// UUID 36 文字 + URL encoding (= comma %2C など) で 1 UUID ≒ 40 chars。
// 50 個なら URL ≒ 2KB に収まり、Supabase pooler / Vercel Edge 等の URL 上限内。
// 旧 300 では URL ~12KB になり net::ERR_FAILED で 一括生成 が落ちていた。
const IN_CHUNK_SIZE = 50;
function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// CSV Export
// ---------------------------------------------------------------------------

function generateCSV(
  claims: ClaimRow[],
  billingMonth: string,
  certMap: Map<string, { care_level: string; insurer_number: string | null; insured_number: string | null; start_date: string | null; end_date: string | null }>
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
      (c.clients?.name ?? "").replace(/,/g, "　"),
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
      .from("offices")
      .select("tokutei_kassan_type, medical_cooperation_kassan")
      .eq("app_type", "kaigo-app")
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
            レセプト編集 — {claim.clients?.name}
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

export interface ClaimsContentProps {
  initialBillingMonth: string;
  initialClaims: ClaimRow[];
  initialCertEntries: [string, CertMapEntry][];
  initialOfficeInfo: ClaimsOfficeInfo;
}

export function ClaimsContent({
  initialBillingMonth,
  initialClaims,
  initialCertEntries,
  initialOfficeInfo,
}: ClaimsContentProps) {
  const supabase = useMemo(() => createClient(), []);
  // 加算管理 (= /addons) を business_type='居宅介護支援' + 現 office で fetch するため
  // 現在選択中の office を取得。BusinessTypeProvider 配下なので必ず取得可。
  const { currentOffice } = useBusinessType();

  const [billingMonth, setBillingMonth] = useState(initialBillingMonth);
  const [claims, setClaims] = useState<ClaimRow[]>(initialClaims);
  const [certMap, setCertMap] = useState<Map<string, CertMapEntry>>(() => new Map(initialCertEntries));
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [editTarget, setEditTarget] = useState<ClaimRow | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [officeInfo] = useState<ClaimsOfficeInfo>(initialOfficeInfo);

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchClaims = useCallback(async () => {
    setLoading(true);
    try {
      // PostgREST 列エイリアスで kaigo_users 旧フィールド名を維持しつつ clients を埋め込む
      // kaigo_care_support_claims.user_id → clients.id (FK redirect 済)
      const { data, error } = await supabase
        .from("kaigo_care_support_claims")
        .select("*, clients(name, name_kana:furigana, gender, phone, mobile_phone:mobile)")
        .eq("billing_month", billingMonth)
        .order("created_at", { ascending: true });

      if (error) throw error;
      const rows = (data as ClaimRow[]) || [];
      setClaims(rows);

      // Fetch certifications for the users in these claims
      const userIds = [...new Set(rows.map((r) => r.user_id))];
      if (userIds.length > 0) {
        // client_insurance_records, カラム名は新スキーマ
        // PostgREST default 1000 行制限対策で page-loop で全件取得 + .in() も chunk 化
        type CertRow = { client_id: string; care_level: string; insurer_number: string | null; insured_number: string | null; certification_start_date: string | null; certification_end_date: string | null };
        const PAGE = 1000;
        const certs: CertRow[] = [];
        for (const idChunk of chunkArray(userIds, IN_CHUNK_SIZE)) {
          let fromC = 0;
          while (true) {
            const { data, error: certsErr } = await supabase
              .from("client_insurance_records")
              .select("client_id, care_level, insurer_number, insured_number, certification_start_date, certification_end_date")
              .in("client_id", idChunk)
              .order("certification_date", { ascending: false })
              .range(fromC, fromC + PAGE - 1);
            if (certsErr) throw certsErr;
            if (!data || data.length === 0) break;
            certs.push(...(data as CertRow[]));
            if (data.length < PAGE) break;
            fromC += PAGE;
          }
        }

        const map = new Map<string, { care_level: string; insurer_number: string | null; insured_number: string | null; start_date: string | null; end_date: string | null }>();
        for (const cert of certs) {
          if (!map.has(cert.client_id)) {
            map.set(cert.client_id, {
              care_level: cert.care_level,
              insurer_number: cert.insurer_number ?? null,
              insured_number: cert.insured_number ?? null,
              start_date: cert.certification_start_date ?? null,
              end_date: cert.certification_end_date ?? null,
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
          (err instanceof Error ? err.message : typeof err === "object" && err !== null && "message" in err ? String((err as any).message) : JSON.stringify(err))
      );
    } finally {
      setLoading(false);
    }
  }, [supabase, billingMonth]);

  // initial render は server からの initialClaims を使用、月切替時のみ refetch
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
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
      // 1. Fetch active users（clients、is_facility=false で法人エントリ除外）
      //    PostgREST default 1000 行制限対策で page-loop で全件取得
      const PAGE_USERS = 1000;
      const users: { id: string; name: string }[] = [];
      {
        let fromU = 0;
        while (true) {
          const { data, error: usersErr } = await supabase
            .from("clients")
            .select("id, name")
            .eq("status", "active")
            .eq("is_facility", false)
            .is("deleted_at", null)
            .range(fromU, fromU + PAGE_USERS - 1);
          if (usersErr) throw usersErr;
          if (!data || data.length === 0) break;
          users.push(...(data as { id: string; name: string }[]));
          if (data.length < PAGE_USERS) break;
          fromU += PAGE_USERS;
        }
      }
      if (users.length === 0) {
        toast.error("在籍中の利用者が見つかりません");
        return;
      }

      const userIds = users.map((u: { id: string }) => u.id);

      // 2. Fetch active care plans
      //    .in() に大量 UUID (>300 個) を渡すと URI Too Long (HTTP 414) で失敗するため chunk 化
      const plans: { user_id: string }[] = [];
      for (const idChunk of chunkArray(userIds, IN_CHUNK_SIZE)) {
        const { data, error: plansErr } = await supabase
          .from("kaigo_care_plans")
          .select("user_id")
          .in("user_id", idChunk)
          .eq("status", "active");
        if (plansErr) throw plansErr;
        if (data) plans.push(...(data as { user_id: string }[]));
      }

      const activeUserIds = new Set(
        plans.map((p: { user_id: string }) => p.user_id)
      );
      if (activeUserIds.size === 0) {
        toast.error("有効なケアプランを持つ利用者が見つかりません");
        return;
      }

      // 3. Fetch latest certifications for those users（client_insurance_records）
      //    PostgREST default 1000 行制限対策で page-loop で全件取得 + .in() も chunk 化
      const PAGE_CERTS = 1000;
      const certs: { client_id: string; care_level: string; insurer_number: string | null; insured_number: string | null }[] = [];
      {
        const activeIds = Array.from(activeUserIds);
        for (const idChunk of chunkArray(activeIds, IN_CHUNK_SIZE)) {
          let fromC = 0;
          while (true) {
            const { data, error: certsErr } = await supabase
              .from("client_insurance_records")
              .select("client_id, care_level, insurer_number, insured_number")
              .in("client_id", idChunk)
              .order("certification_date", { ascending: false })
              .range(fromC, fromC + PAGE_CERTS - 1);
            if (certsErr) throw certsErr;
            if (!data || data.length === 0) break;
            certs.push(...(data as { client_id: string; care_level: string; insurer_number: string | null; insured_number: string | null }[]));
            if (data.length < PAGE_CERTS) break;
            fromC += PAGE_CERTS;
          }
        }
      }

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
        if (!certMap.has(cert.client_id)) {
          certMap.set(cert.client_id, {
            care_level: cert.care_level,
            insurer_number: cert.insurer_number ?? null,
            insured_number: cert.insured_number ?? null,
          });
        }
      }

      // 4. Fetch office settings for auto-apply（共通マスタ offices, kaigo-app の自事業所）
      const { data: officeSettings, error: officeErr } = await supabase
        .from("offices")
        .select("tokutei_kassan_type, medical_cooperation_kassan, unit_price, area_category")
        .eq("app_type", "kaigo-app")
        .limit(1)
        .maybeSingle();
      if (officeErr) throw officeErr;

      // 4-a. 単位数単価: 地域区分を最優先で算出。
      //   - offices.area_category (= "1級地"〜"7級地"/"その他") → 法令単価表 で引く
      //   - area_category が無い場合のみ offices.unit_price の手動値、それも無ければ 10.00
      const officeArea = (officeSettings?.area_category as string | null) ?? null;
      const officeUnitPrice = officeArea
        ? getUnitPriceByArea(officeArea)
        : Number(officeSettings?.unit_price ?? 10);

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
      if (ratesRes.error) throw ratesRes.error;
      if (tkRatesRes.error) throw tkRatesRes.error;

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

      // 5-a. 加算管理 (= /addons) から「この月に有効な」加算を取得。
      //     ─ business_type='居宅介護支援' + 現 office に限定
      //     ─ status='active' AND applied_from <= 月末 AND (expires_at IS NULL OR expires_at >= 月初)
      //     ─ 取得できない場合 (= currentOffice 未確定 / fetch error) は無視して fallback へ
      type ActiveAddon = {
        addon_code: string;
        addon_unit: number | null;
        applied_from: string;
        expires_at: string | null;
        status: string;
      };
      const activeAddons: ActiveAddon[] = [];
      const useAddons = !!currentOffice?.id;
      if (useAddons) {
        const PAGE_ADDONS = 1000;
        let fromA = 0;
        while (true) {
          const { data, error: addonsErr } = await supabase
            .from("kaigo_billing_addons")
            .select("addon_code, addon_unit, applied_from, expires_at, status")
            .eq("office_id", currentOffice.id)
            .eq("business_type", "居宅介護支援")
            .eq("status", "active")
            .range(fromA, fromA + PAGE_ADDONS - 1);
          if (addonsErr) throw addonsErr;
          if (!data || data.length === 0) break;
          activeAddons.push(...(data as ActiveAddon[]));
          if (data.length < PAGE_ADDONS) break;
          fromA += PAGE_ADDONS;
        }
      }
      // 月内有効分のみに絞り込み
      const monthActiveAddons = activeAddons.filter((a) =>
        isAddonActiveInMonth(a, billingMonth),
      );
      // 加算コードでまとめる (= 同 code が複数登録されている場合は applied_from 最新を採用)
      const addonByCode = new Map<string, ActiveAddon>();
      for (const a of monthActiveAddons) {
        const prev = addonByCode.get(a.addon_code);
        if (!prev || a.applied_from > prev.applied_from) {
          addonByCode.set(a.addon_code, a);
        }
      }

      /** addon_code に対応する 単位数を取得 (DB rates → addon_unit → 法令 hardcode の順) */
      const resolveAddonUnits = (code: string): number => {
        const a = addonByCode.get(code);
        // 特定事業所加算は kaigo_tokutei_kassan_rates を最優先
        const tokuteiType = ADDON_CODE_TO_TOKUTEI[code];
        if (tokuteiType) {
          return TOKUTEI_KASSAN_UNITS[tokuteiType] ?? 0;
        }
        // ユーザが addon_unit を明示入力していればそれを使う
        if (a && a.addon_unit != null) return a.addon_unit;
        // 法令 hardcode fallback
        return KYOTAKU_ADDON_LAW_UNITS[code] ?? 0;
      };

      // 5-b. addons table 由来の office 単位加減算を決定。
      //   - 特定事業所加算: addons 優先、無ければ offices.tokutei_kassan_type を fallback
      //   - 医療介護連携加算: addons table には独立 code が無いので
      //     既存通り offices.medical_cooperation_kassan を fallback
      //     (= ※ 将来加算 master 一覧に追加されたら addon 由来に統一)
      const addonsHasTokutei =
        addonByCode.has("特定事業所加算Ⅰ") ||
        addonByCode.has("特定事業所加算Ⅱ") ||
        addonByCode.has("特定事業所加算Ⅲ") ||
        addonByCode.has("特定事業所加算A");
      let officeTokutei: TokuteiKassanType;
      let tokuteiSource: "addons" | "master" = "master";
      if (addonsHasTokutei) {
        tokuteiSource = "addons";
        if (addonByCode.has("特定事業所加算Ⅰ")) officeTokutei = "Ⅰ";
        else if (addonByCode.has("特定事業所加算Ⅱ")) officeTokutei = "Ⅱ";
        else if (addonByCode.has("特定事業所加算Ⅲ")) officeTokutei = "Ⅲ";
        else officeTokutei = "A";
      } else {
        officeTokutei = normalizeTokuteiKassan(officeSettings?.tokutei_kassan_type);
      }
      const officeMedicalCoop = officeSettings?.medical_cooperation_kassan ?? false;
      const officeTokuteiUnits = TOKUTEI_KASSAN_UNITS[officeTokutei] ?? 0;
      const officeMedicalCoopUnits = officeMedicalCoop ? 125 : 0;

      // 5-c. 利用者単位の加算 (= 退院・退所 / 入院時情報連携 / ターミナル / 緊急時カンファ / 医療連携)
      //   これらは事業所単位ではなく「該当する利用者にだけ算定」だが、
      //   /addons には事業所単位でしか登録されていない。
      //   → 当面は「事業所として算定届出済の加算は draft 段階で全員に自動算定」とする (= 安全側)
      //     ユーザは行ごとの checkbox で個別に off にできる。
      const autoHospitalCode = (() => {
        if (addonByCode.has("入院時情報連携加算Ⅰ")) return "入院時情報連携加算Ⅰ";
        if (addonByCode.has("入院時情報連携加算Ⅱ")) return "入院時情報連携加算Ⅱ";
        return null;
      })();
      const autoDischargeCode = (() => {
        if (addonByCode.has("退院・退所加算Ⅲ")) return "退院・退所加算Ⅲ";
        if (addonByCode.has("退院・退所加算Ⅱロ")) return "退院・退所加算Ⅱロ";
        if (addonByCode.has("退院・退所加算Ⅱイ")) return "退院・退所加算Ⅱイ";
        if (addonByCode.has("退院・退所加算Ⅰロ")) return "退院・退所加算Ⅰロ";
        if (addonByCode.has("退院・退所加算Ⅰイ")) return "退院・退所加算Ⅰイ";
        return null;
      })();
      const autoMedicalCoordCode = addonByCode.has("医療連携加算") ? "医療連携加算" : null;
      const autoTerminalCode = addonByCode.has("ターミナルケアマネジメント加算")
        ? "ターミナルケアマネジメント加算"
        : null;
      const autoEmergencyCode = addonByCode.has("緊急時等居宅カンファレンス加算")
        ? "緊急時等居宅カンファレンス加算"
        : null;

      // 5-d. 初回加算 自動算定 用に「過去 claims に既出の user_id」を取得。
      //     billing_month は TEXT 'YYYY-MM' なので lexicographic 比較で「当月未満」が取れる。
      //     当月 (= 既存の同 month claims) は手順 6 で delete されるため対象外。
      type PriorClaimRow = { user_id: string };
      const priorUserIds = new Set<string>();
      {
        const PAGE_PRIOR = 1000;
        let fromP = 0;
        while (true) {
          const { data, error: priorErr } = await supabase
            .from("kaigo_care_support_claims")
            .select("user_id")
            .lt("billing_month", billingMonth)
            .range(fromP, fromP + PAGE_PRIOR - 1);
          if (priorErr) throw priorErr;
          if (!data || data.length === 0) break;
          for (const r of data as PriorClaimRow[]) priorUserIds.add(r.user_id);
          if (data.length < PAGE_PRIOR) break;
          fromP += PAGE_PRIOR;
        }
      }
      const initialAddonAvailable = addonByCode.has("初回加算");

      // 5-e. 介護予防支援費 (要支援1/2) — kaigo_service_codes の対象月有効世代から取得
      //     (kaigo_care_support_rates の固定 443 単位は使わない。R6.4 以降は Ⅰ/Ⅱ の 2 区分)
      const yoboCodes = await fetchYoboShienCodes(supabase, billingMonth);

      // 5-f. 利用者ごとの予防支援区分 (Ⅰ/Ⅱ/委託) — claims.notes のマーカーを
      //     billing_month 降順で走査し、直近の選択を引き継ぐ (当月分は削除前なので含む)
      const yoboKubunByUser = new Map<string, YoboShienKubun>();
      {
        const PAGE_YK = 1000;
        let fromY = 0;
        while (true) {
          const { data, error: ykErr } = await supabase
            .from("kaigo_care_support_claims")
            .select("user_id, billing_month, notes")
            .like("notes", "%[予防支援:%")
            .order("billing_month", { ascending: false })
            .range(fromY, fromY + PAGE_YK - 1);
          if (ykErr) throw ykErr;
          if (!data || data.length === 0) break;
          for (const r of data as { user_id: string; notes: string | null }[]) {
            if (yoboKubunByUser.has(r.user_id)) continue;
            const k = parseYoboShienKubun(r.notes);
            if (k) yoboKubunByUser.set(r.user_id, k);
          }
          if (data.length < PAGE_YK) break;
          fromY += PAGE_YK;
        }
      }

      // 6. Delete existing claims for this month
      const { error: delErr } = await supabase
        .from("kaigo_care_support_claims")
        .delete()
        .eq("billing_month", billingMonth);
      if (delErr) throw delErr;

      // 7. Build insert rows
      const now = new Date().toISOString();
      const rows: Record<string, unknown>[] = [];

      for (const user of users as { id: string; name: string }[]) {
        if (!activeUserIds.has(user.id)) continue;
        const cert = certMap.get(user.id);
        if (!cert) continue;

        // ── 介護予防支援 (要支援1/2) の区分判定 ──
        const isYobo = isYoboShienLevel(cert.care_level);
        const yoboKubun: YoboShienKubun | null = isYobo
          ? (yoboKubunByUser.get(user.id) ?? "II")
          : null;

        // 委託 (= 地域包括支援センターが請求) は請求対象外の 0 単位行を残す
        // (区分選択の永続化 + 一覧での「請求対象外」表示のため。CSV/伝送出力からは除外)
        if (yoboKubun === "itaku") {
          rows.push({
            user_id: user.id,
            billing_month: billingMonth,
            care_support_code: yoboCodes.II?.code ?? CARE_LEVEL_MAP[cert.care_level]?.code ?? "461112",
            care_support_name: "介護予防支援 (委託)",
            units: 0,
            unit_price: officeUnitPrice,
            total_amount: 0,
            insurance_amount: 0,
            initial_addition: false,
            initial_addition_units: 0,
            hospital_coordination: false,
            hospital_coordination_units: 0,
            discharge_addition: false,
            discharge_addition_units: 0,
            medical_coordination: false,
            medical_coordination_units: 0,
            tokutei_kassan_type: null,
            tokutei_kassan_units: 0,
            medical_coop_kassan: false,
            medical_coop_kassan_units: 0,
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
            notes: `${AUTO_ADDON_NOTES_MARKER} 介護予防支援 委託 (地域包括支援センターが請求するため請求対象外)\n${YOBO_SHIEN_MARKER.itaku}`,
            created_at: now,
          });
          continue;
        }

        let levelInfo = CARE_LEVEL_MAP[cert.care_level];
        if (yoboKubun) {
          const yc = yoboKubun === "I" ? yoboCodes.I : yoboCodes.II;
          if (yc) levelInfo = yc;
        }
        if (!levelInfo) continue;

        // ── 自動算定 加算 (= 事業所単位の届出加算を draft で全員に展開) ──
        // 介護予防支援には居宅介護支援費の加算 (特定事業所・退院退所・入院時情報等) は
        // 算定できないため、要支援者は初回加算 (介護予防支援 初回加算 300 単位) のみ自動算定
        const uDischargeCode = isYobo ? null : autoDischargeCode;
        const uHospitalCode = isYobo ? null : autoHospitalCode;
        const uMedicalCoordCode = isYobo ? null : autoMedicalCoordCode;
        const uTerminalCode = isYobo ? null : autoTerminalCode;
        const uEmergencyCode = isYobo ? null : autoEmergencyCode;
        const uTokutei: TokuteiKassanType = isYobo ? "none" : officeTokutei;
        const uTokuteiUnits = isYobo ? 0 : officeTokuteiUnits;
        const uMedicalCoop = isYobo ? false : officeMedicalCoop;
        const uMedicalCoopUnits = isYobo ? 0 : officeMedicalCoopUnits;
        // 退院・退所加算
        const dischargeType: DischargeType | null = uDischargeCode
          ? (ADDON_CODE_TO_DISCHARGE_TYPE[uDischargeCode] ?? null)
          : null;
        const dischargeUnits = uDischargeCode ? resolveAddonUnits(uDischargeCode) : 0;
        // 入院時情報連携加算
        const hospitalType: HospitalCoordType | null = uHospitalCode
          ? (ADDON_CODE_TO_HOSPITAL_TYPE[uHospitalCode] ?? null)
          : null;
        const hospitalUnits = uHospitalCode ? resolveAddonUnits(uHospitalCode) : 0;
        // 医療連携加算 (= 通院時情報連携)
        const medicalCoordUnits = uMedicalCoordCode ? resolveAddonUnits(uMedicalCoordCode) : 0;
        // ターミナルケア
        const terminalUnits = uTerminalCode ? resolveAddonUnits(uTerminalCode) : 0;
        // 緊急時カンファレンス
        const emergencyUnits = uEmergencyCode ? resolveAddonUnits(uEmergencyCode) : 0;
        // 初回加算 (= 過去 claims に user_id が無い場合のみ)
        const isInitial = initialAddonAvailable && !priorUserIds.has(user.id);
        const initialUnits = isInitial ? (KYOTAKU_ADDON_LAW_UNITS["初回加算"] ?? 300) : 0;

        const autoAddUnits =
          uTokuteiUnits +
          uMedicalCoopUnits +
          dischargeUnits +
          hospitalUnits +
          medicalCoordUnits +
          terminalUnits +
          emergencyUnits +
          initialUnits;
        const { total_amount } = calcTotals(levelInfo.units, autoAddUnits, 0, officeUnitPrice);

        // 自動算定の根拠を notes に印で残す
        const noteParts: string[] = [];
        if (yoboKubun) {
          noteParts.push(
            `${AUTO_ADDON_NOTES_MARKER} ${levelInfo.name} ${levelInfo.units}単位 (kaigo_service_codes 対象月有効世代)`,
          );
        }
        if (uTokutei !== "none") {
          noteParts.push(
            `${AUTO_ADDON_NOTES_MARKER} 特定事業所加算${uTokutei} (${tokuteiSource === "addons" ? "加算管理" : "/master/office"} 由来)`,
          );
        }
        if (uMedicalCoop) {
          noteParts.push(`${AUTO_ADDON_NOTES_MARKER} 特定事業所医療介護連携加算 (/master/office)`);
        }
        if (uDischargeCode) noteParts.push(`${AUTO_ADDON_NOTES_MARKER} ${uDischargeCode} (加算管理)`);
        if (uHospitalCode) noteParts.push(`${AUTO_ADDON_NOTES_MARKER} ${uHospitalCode} (加算管理)`);
        if (uMedicalCoordCode) noteParts.push(`${AUTO_ADDON_NOTES_MARKER} ${uMedicalCoordCode} (加算管理)`);
        if (uTerminalCode) noteParts.push(`${AUTO_ADDON_NOTES_MARKER} ${uTerminalCode} (加算管理)`);
        if (uEmergencyCode) noteParts.push(`${AUTO_ADDON_NOTES_MARKER} ${uEmergencyCode} (加算管理)`);
        if (isInitial) noteParts.push(`${AUTO_ADDON_NOTES_MARKER} 初回加算 (= 過去月 claims なしと判定)`);
        // 単価 source
        noteParts.push(
          officeArea
            ? `${AUTO_ADDON_NOTES_MARKER} 単価 ${officeUnitPrice.toFixed(2)}円 (地域区分: ${officeArea})`
            : `${AUTO_ADDON_NOTES_MARKER} 単価 ${officeUnitPrice.toFixed(2)}円 (offices.unit_price)`,
        );
        // 予防支援区分マーカー (Ⅰ/Ⅱ) — 次回一括生成時の引継ぎ用
        if (yoboKubun) noteParts.push(YOBO_SHIEN_MARKER[yoboKubun]);
        const autoNotes = noteParts.join("\n");

        rows.push({
          user_id: user.id,
          billing_month: billingMonth,
          care_support_code: levelInfo.code,
          care_support_name: levelInfo.name,
          units: levelInfo.units,
          unit_price: officeUnitPrice,
          total_amount,
          insurance_amount: total_amount,
          initial_addition: isInitial,
          initial_addition_units: initialUnits,
          hospital_coordination: hospitalType !== null,
          hospital_coordination_units: hospitalUnits,
          discharge_addition: dischargeType !== null,
          discharge_addition_units: dischargeUnits,
          medical_coordination: medicalCoordUnits > 0,
          medical_coordination_units: medicalCoordUnits,
          tokutei_kassan_type: uTokutei === "none" ? null : uTokutei,
          tokutei_kassan_units: uTokuteiUnits,
          medical_coop_kassan: uMedicalCoop,
          medical_coop_kassan_units: uMedicalCoopUnits,
          discharge_type: dischargeType,
          terminal_care: terminalUnits > 0,
          terminal_care_units: terminalUnits,
          emergency_conference: emergencyUnits > 0,
          emergency_conference_units: emergencyUnits,
          bcp_not_prepared: false,
          bcp_reduction_pct: 0,
          abuse_prevention_not_implemented: false,
          abuse_reduction_pct: 0,
          status: "draft",
          notes: autoNotes,
          created_at: now,
        });
      }

      if (rows.length === 0) {
        toast.error("生成できるレセプトデータがありませんでした");
        return;
      }

      // 大量 row の INSERT は payload が膨らみネットワーク失敗の元なので chunk 化
      for (const chunk of chunkArray(rows, 200)) {
        const { error: insertErr } = await supabase
          .from("kaigo_care_support_claims")
          .insert(chunk);
        if (insertErr) {
          console.error("Insert failed:", insertErr);
          throw insertErr;
        }
      }

      toast.success(
        `${formatMonth(billingMonth)}のレセプトを${rows.length}件生成しました`
      );
      fetchClaims();
    } catch (err: unknown) {
      // Supabase JS は HTTP 414/500 等で空 message を返したり、ブラウザ fetch が
      // "TypeError: Failed to fetch" で reject することがある。詳細を console に
      // 残しつつ、ユーザには分かりやすい toast を出す。
      console.error("一括生成エラー (詳細):", err);
      const errObj = (typeof err === "object" && err !== null) ? (err as Record<string, unknown>) : null;
      const rawMsg = err instanceof Error
        ? err.message
        : errObj && "message" in errObj
          ? String(errObj.message)
          : JSON.stringify(err);
      const friendly = (() => {
        if (!rawMsg) return "サーバから空の応答 (おそらく URI Too Long / ネットワーク中断)。コンソールを確認してください";
        if (/Failed to fetch/i.test(rawMsg)) return "ネットワーク要求が失敗しました (URI が長すぎる/接続切断の可能性)。コンソールを確認してください";
        const code = errObj && "code" in errObj ? String(errObj.code) : "";
        return code ? `${code}: ${rawMsg}` : rawMsg;
      })();
      toast.error("一括生成に失敗しました: " + friendly);
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
          (err instanceof Error ? err.message : typeof err === "object" && err !== null && "message" in err ? String((err as any).message) : JSON.stringify(err))
      );
    }
  };

  // ClaimRow から現在の Addings を抽出
  const claimToAddings = (c: ClaimRow): Addings => ({
    initial: c.initial_addition,
    tokutei_kassan: normalizeTokuteiKassan(c.tokutei_kassan_type as string | null),
    medical_coop_kassan: c.medical_coop_kassan ?? false,
    hospitalization: (() => {
      if (!c.hospital_coordination) return "none";
      return c.hospital_coordination_units >= 250 ? "i" : "ii";
    })() as HospitalCoordType,
    discharge: (c.discharge_type as DischargeType) ?? (c.discharge_addition ? "i_ro" : "none"),
    outpatient: c.medical_coordination,
    terminal_care: c.terminal_care ?? false,
    emergency_conference: c.emergency_conference ?? false,
    bcp_not_prepared: c.bcp_not_prepared ?? false,
    abuse_prevention_not_implemented: c.abuse_prevention_not_implemented ?? false,
  });

  // 一カラムだけを即時更新する（チェックボックス・プルダウン操作用）
  const handleQuickPatch = async (claim: ClaimRow, patch: Partial<Addings>) => {
    const current = claimToAddings(claim);
    const next = { ...current, ...patch };
    await handleEditSave(claim.id, next, claim.unit_price);
  };

  // ── 予防支援区分 (Ⅰ/Ⅱ/委託) の切替 ──────────────────────────────────────
  const handleYoboKubunChange = async (claim: ClaimRow, kubun: YoboShienKubun) => {
    try {
      const notes = setYoboShienMarker(claim.notes, kubun);
      if (kubun === "itaku") {
        // 委託 = 包括が請求 → 請求対象外 (0 単位化 + 加算全解除)
        const { error } = await supabase
          .from("kaigo_care_support_claims")
          .update({
            care_support_name: "介護予防支援 (委託)",
            units: 0,
            total_amount: 0,
            insurance_amount: 0,
            initial_addition: false,
            initial_addition_units: 0,
            hospital_coordination: false,
            hospital_coordination_units: 0,
            discharge_addition: false,
            discharge_addition_units: 0,
            discharge_type: null,
            medical_coordination: false,
            medical_coordination_units: 0,
            tokutei_kassan_type: null,
            tokutei_kassan_units: 0,
            medical_coop_kassan: false,
            medical_coop_kassan_units: 0,
            terminal_care: false,
            terminal_care_units: 0,
            emergency_conference: false,
            emergency_conference_units: 0,
            notes,
            updated_at: new Date().toISOString(),
          })
          .eq("id", claim.id);
        if (error) throw error;
      } else {
        const codes = await fetchYoboShienCodes(supabase, billingMonth);
        const yc = kubun === "I" ? codes.I : codes.II;
        if (!yc) {
          toast.error(
            `対象月に有効な介護予防支援費(${kubun === "I" ? "Ⅰ" : "Ⅱ"})のサービスコードがマスタにありません`,
          );
          return;
        }
        const addings = claimToAddings(claim);
        const addUnits = calcAdditionUnits(addings);
        const reductionUnits = calcReductionUnits(yc.units, addings);
        const { total_amount } = calcTotals(yc.units, addUnits, reductionUnits, claim.unit_price);
        const { error } = await supabase
          .from("kaigo_care_support_claims")
          .update({
            care_support_code: yc.code,
            care_support_name: yc.name,
            units: yc.units,
            total_amount,
            insurance_amount: total_amount,
            notes,
            updated_at: new Date().toISOString(),
          })
          .eq("id", claim.id);
        if (error) throw error;
      }
      toast.success("予防支援区分を更新しました");
      fetchClaims();
    } catch (err: unknown) {
      console.error("予防支援区分の更新エラー:", err);
      toast.error(
        "予防支援区分の更新に失敗しました: " +
          (err instanceof Error ? err.message : JSON.stringify(err)),
      );
    }
  };

  // ── CSV Export ────────────────────────────────────────────────────────────

  const handleCSVExport = () => {
    if (claims.length === 0) {
      toast.error("出力するデータがありません");
      return;
    }
    // 委託 (予防支援) は包括が請求するため出力対象外
    const confirmed = claims.filter(
      (c) => c.status !== "draft" && parseYoboShienKubun(c.notes) !== "itaku",
    );
    if (confirmed.length === 0) {
      toast.error("確定済みのレセプトがありません。確定後に出力してください。");
      return;
    }
    const csv = generateCSV(confirmed, billingMonth, certMap);
    const filename = `居宅介護支援_レセプト_${billingMonth.replace("-", "")}.csv`;
    downloadCSV(csv, filename);
    toast.success(`${confirmed.length}件のCSVを出力しました`);
  };

  // ── 国保連伝送用 固定長テキスト出力 ──────────────────────────────────
  const handleKokuhoExport = async () => {
    if (claims.length === 0) {
      toast.error("出力するデータがありません");
      return;
    }
    // 委託 (予防支援) は包括が請求するため出力対象外
    const confirmed = claims.filter(
      (c) => c.status !== "draft" && parseYoboShienKubun(c.notes) !== "itaku",
    );
    if (confirmed.length === 0) {
      toast.error("確定済みのレセプトがありません。確定後に出力してください。");
      return;
    }

    try {
      // 自事業所設定を取得（共通マスタ offices, kaigo-app）
      const { data: officeData } = await supabase
        .from("offices")
        .select("provider_number:business_number, area_category, unit_price")
        .eq("app_type", "kaigo-app")
        .limit(1)
        .maybeSingle();

      const providerNumber = (officeData as { provider_number?: string } | null)?.provider_number ?? "0000000000";
      const unitPrice = Number(officeData?.unit_price ?? 10);
      const areaCode = areaCategoryToCode(officeData?.area_category ?? "その他");

      // 利用者情報（生年月日・性別）を取得（clients）
      const userIds = [...new Set(confirmed.map((c) => c.user_id))];
      const { data: usersData } = await supabase
        .from("clients")
        .select("id, birth_date, gender")
        .in("id", userIds);
      const userInfoMap = new Map<string, { birth_date: string | null; gender: string | null }>();
      for (const u of usersData || []) {
        userInfoMap.set(u.id, { birth_date: u.birth_date ?? null, gender: u.gender ?? null });
      }

      // Dynamic import to avoid server bundling
      const { downloadCareMgmtFile } = await import("@/lib/kokuho-renkei");

      const serviceYearMonth = billingMonth.replace("-", ""); // "2026-04" → "202604"

      // ClaimRowからCareMgmtClaim形式に変換
      const careMgmtClaims = confirmed.map((c) => {
        const cert = certMap.get(c.user_id);
        const userName = c.clients?.name ?? "";
        const insuredNumber = cert?.insured_number ?? "";
        const insurerNumber = cert?.insurer_number ?? "";
        const careLevelCode = careLevelToCode(cert?.care_level ?? "");

        // 加算レコード
        const additions: Array<{
          serviceItemCode: string;
          units: number;
          count: number;
          serviceUnits: number;
          note?: string;
        }> = [];
        if (c.initial_addition) {
          additions.push({
            serviceItemCode: "4000",
            units: c.initial_addition_units,
            count: 1,
            serviceUnits: c.initial_addition_units,
            note: "初回加算",
          });
        }
        if (c.tokutei_kassan_type && c.tokutei_kassan_units > 0) {
          additions.push({
            serviceItemCode: "6132",
            units: c.tokutei_kassan_units,
            count: 1,
            serviceUnits: c.tokutei_kassan_units,
            note: `特定事業所加算(${c.tokutei_kassan_type})`,
          });
        }
        if (c.medical_coop_kassan) {
          additions.push({
            serviceItemCode: "6135",
            units: c.medical_coop_kassan_units || 125,
            count: 1,
            serviceUnits: c.medical_coop_kassan_units || 125,
            note: "特定事業所医療介護連携加算",
          });
        }
        if (c.hospital_coordination && c.hospital_coordination_units > 0) {
          additions.push({
            serviceItemCode: "4001",
            units: c.hospital_coordination_units,
            count: 1,
            serviceUnits: c.hospital_coordination_units,
            note: "入院時情報連携加算",
          });
        }
        if (c.discharge_addition && c.discharge_addition_units > 0) {
          additions.push({
            serviceItemCode: "4002",
            units: c.discharge_addition_units,
            count: 1,
            serviceUnits: c.discharge_addition_units,
            note: "退院・退所加算",
          });
        }

        const additionTotalUnits = additions.reduce((sum, a) => sum + a.serviceUnits, 0);
        const totalUnits = c.units + additionTotalUnits;

        const uInfo = userInfoMap.get(c.user_id);
        const birthDate = (uInfo?.birth_date ?? "").replace(/-/g, "") || "19500101";
        const genderCode = uInfo?.gender === "女" ? ("2" as const) : ("1" as const);

        return {
          base: {
            exchangeId: "7121",
            serviceYearMonth,
            providerNumber,
            serviceTypeCode: "43",
            areaCode,
            insuredNumber,
            userName,
            birthDate,
            gender: genderCode,
            careLevelCode,
            certStartDate: (cert?.start_date ?? "20240401").replace(/-/g, ""),
            certEndDate: (cert?.end_date ?? "20270331").replace(/-/g, ""),
            insurerNumber,
            totalUnits,
          },
          mainService: {
            serviceItemCode: c.care_support_code.slice(-4),
            units: c.units,
            count: 1,
            serviceUnits: c.units,
            note: c.care_support_name,
          },
          additions,
          shukei: {
            actualDays: 1,
            plannedUnits: totalUnits,
            limitManagementUnits: 0, // 居宅介護支援費は限度額管理対象外
            nonLimitUnits: totalUnits,
            benefitUnits: totalUnits,
            unitPrice,
            totalCost: c.total_amount,
            insuranceClaim: c.insurance_amount,
            userCopay: 0, // 居宅介護支援は10割給付
          },
        };
      });

      downloadCareMgmtFile({
        serviceYearMonth,
        providerNumber,
        areaCode,
        unitPrice,
        claims: careMgmtClaims,
      });

      toast.success(`${confirmed.length}件の国保連伝送用ファイルを出力しました`);
    } catch (err) {
      console.error(err);
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("伝送用ファイルの出力に失敗しました: " + msg);
    }
  };

  // 要介護度→コード変換
  const careLevelToCode = (careLevel: string): string => {
    const map: Record<string, string> = {
      "要支援1": "12", "要支援2": "13",
      "要介護1": "21", "要介護2": "22", "要介護3": "23",
      "要介護4": "24", "要介護5": "25",
    };
    return map[careLevel] ?? "00";
  };

  // 地域区分→コード変換
  const areaCategoryToCode = (area: string): number => {
    const map: Record<string, number> = {
      "1級地": 1, "2級地": 2, "3級地": 3, "4級地": 4,
      "5級地": 5, "6級地": 6, "7級地": 7, "その他": 8,
    };
    return map[area] ?? 8;
  };

  // ── Row expand ────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
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
          {/* Billing month with prev/next arrows */}
          <div className="inline-flex items-center gap-1">
            <button
              onClick={() => {
                const [y, m] = billingMonth.split("-").map(Number);
                const d = new Date(y, m - 2, 1);
                setBillingMonth(
                  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
                );
              }}
              className="rounded-lg border px-2 py-2 text-gray-600 hover:bg-gray-50 transition-colors"
              title="前月"
              aria-label="前月"
            >
              ‹
            </button>
            <input
              type="month"
              value={billingMonth}
              onChange={(e) => setBillingMonth(e.target.value)}
              className="rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              onClick={() => {
                const [y, m] = billingMonth.split("-").map(Number);
                const d = new Date(y, m, 1);
                setBillingMonth(
                  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
                );
              }}
              className="rounded-lg border px-2 py-2 text-gray-600 hover:bg-gray-50 transition-colors"
              title="翌月"
              aria-label="翌月"
            >
              ›
            </button>
          </div>

          {/* Refresh */}
          <button
            onClick={fetchClaims}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            再読込
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

          {/* 国保連伝送用（固定長テキスト）出力 */}
          <button
            onClick={handleKokuhoExport}
            disabled={summary.confirmed === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 transition-colors disabled:opacity-50"
            title="確定済みレセプトから国保連伝送用ファイル（固定長テキスト・Shift-JIS）を出力"
          >
            <Download size={14} />
            国保連伝送用
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

      {/* 事業所単位の加減算バー */}
      {officeInfo && (
        <div className="rounded-lg border bg-white p-3 shadow-sm">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold text-gray-700 mr-2">事業所単位の加減算:</span>
            {(() => {
              const tokutei = normalizeTokuteiKassan(officeInfo.tokutei_kassan_type);
              const badges: { label: string; active: boolean; color: string }[] = [
                {
                  label: tokutei !== "none" ? `特定事業所加算${tokutei}` : "特定事業所加算",
                  active: tokutei !== "none",
                  color: "indigo",
                },
                {
                  label: "医療介護連携加算",
                  active: officeInfo.medical_cooperation_kassan,
                  color: "cyan",
                },
                {
                  label: `地域区分: ${officeInfo.area_category ?? "その他"}`,
                  active: true,
                  color: "gray",
                },
                {
                  label: `単価 ${Number(officeInfo.unit_price).toFixed(2)}円`,
                  active: true,
                  color: "gray",
                },
              ];
              return badges.map((b, i) => (
                <span
                  key={i}
                  className={
                    b.active
                      ? b.color === "indigo"
                        ? "rounded-full border border-indigo-300 bg-indigo-50 px-2.5 py-0.5 font-medium text-indigo-700"
                        : b.color === "cyan"
                          ? "rounded-full border border-cyan-300 bg-cyan-50 px-2.5 py-0.5 font-medium text-cyan-700"
                          : "rounded-full border border-gray-300 bg-gray-50 px-2.5 py-0.5 font-medium text-gray-700"
                      : "rounded-full border border-gray-200 px-2.5 py-0.5 text-gray-400"
                  }
                >
                  {b.active && (b.color === "indigo" || b.color === "cyan") && "● "}
                  {b.label}
                </span>
              ));
            })()}
            <a
              href="/master/office"
              className="ml-auto text-xs text-blue-600 hover:underline"
            >
              事業所設定を編集 →
            </a>
          </div>
        </div>
      )}

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
            <table className="w-full text-xs border-collapse">
              <thead className="border-b bg-gray-100">
                <tr>
                  <th className="sticky left-0 bg-gray-100 border-r border-gray-200 px-2 py-2 text-left font-semibold text-gray-700 whitespace-nowrap" style={{ minWidth: 160 }}>
                    利用者名
                    <div className="text-[10px] font-normal text-gray-500">フリガナ</div>
                  </th>
                  <th className="border-r border-gray-200 px-1 py-2 text-center font-semibold text-gray-700 whitespace-nowrap" style={{ width: 40 }}>
                    性別
                  </th>
                  <th className="border-r border-gray-200 px-2 py-2 text-left font-semibold text-gray-700 whitespace-nowrap" style={{ minWidth: 120 }}>
                    電話番号
                  </th>
                  <th className="border-r border-gray-200 px-1 py-2 text-center font-semibold text-gray-700 whitespace-nowrap" style={{ width: 50 }}>
                    要介護度
                  </th>
                  <th className="border-r border-gray-200 px-1 py-2 text-center font-semibold text-purple-700 whitespace-nowrap" style={{ width: 76 }}>
                    予防支援<br/>区分
                  </th>
                  {/* 加算カラム */}
                  <th className="border-r border-gray-200 px-1 py-2 text-center font-semibold text-blue-700 whitespace-nowrap" style={{ width: 48 }}>
                    初回<br/>加算
                  </th>
                  <th className="border-r border-gray-200 px-1 py-2 text-center font-semibold text-blue-700 whitespace-nowrap" style={{ width: 70 }}>
                    退院・退所<br/>加算
                  </th>
                  <th className="border-r border-gray-200 px-1 py-2 text-center font-semibold text-blue-700 whitespace-nowrap" style={{ width: 70 }}>
                    入院時情報<br/>連携加算
                  </th>
                  <th className="border-r border-gray-200 px-1 py-2 text-center font-semibold text-blue-700 whitespace-nowrap" style={{ width: 56 }}>
                    緊急時等<br/>カンファ
                  </th>
                  <th className="border-r border-gray-200 px-1 py-2 text-center font-semibold text-blue-700 whitespace-nowrap" style={{ width: 56 }}>
                    ターミナル<br/>ケア
                  </th>
                  <th className="border-r border-gray-200 px-1 py-2 text-center font-semibold text-blue-700 whitespace-nowrap" style={{ width: 56 }}>
                    通院時情報<br/>連携加算
                  </th>
                  <th className="border-r border-gray-200 px-1 py-2 text-center font-semibold text-blue-700 whitespace-nowrap" style={{ width: 56 }}>
                    医療介護<br/>連携
                  </th>
                  {/* 減算カラム */}
                  <th className="border-r border-gray-200 px-1 py-2 text-center font-semibold text-red-700 whitespace-nowrap bg-red-50/40" style={{ width: 48 }}>
                    業務<br/>未策定
                  </th>
                  <th className="border-r border-gray-200 px-1 py-2 text-center font-semibold text-red-700 whitespace-nowrap bg-red-50/40" style={{ width: 48 }}>
                    虐待<br/>未実施
                  </th>
                  {/* 単位数・請求額 */}
                  <th className="border-r border-gray-200 px-2 py-2 text-right font-semibold text-gray-700 whitespace-nowrap" style={{ width: 60 }}>
                    単位数
                  </th>
                  <th className="border-r border-gray-200 px-2 py-2 text-right font-semibold text-gray-700 whitespace-nowrap" style={{ width: 80 }}>
                    請求額
                  </th>
                  <th className="px-2 py-2 text-center font-semibold text-gray-700 whitespace-nowrap" style={{ width: 90 }}>
                    状態
                  </th>
                </tr>
              </thead>
              <tbody>
                {claims.map((claim) => {
                  const certEntry = certMap.get(claim.user_id);
                  const user = claim.clients;
                  const disabled = claim.status !== "draft"; // 確定済みはロック
                  // 委託 (予防支援) 行は請求対象外 → 加算入力もロック (区分 select は変更可)
                  const itakuRow = parseYoboShienKubun(claim.notes) === "itaku";
                  const addonDisabled = disabled || itakuRow;
                  const inputCls = "w-full border border-gray-300 rounded px-1 py-0.5 text-[11px] bg-white focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed";
                  return (
                    <tr
                      key={claim.id}
                      className="border-b border-gray-200 hover:bg-blue-50/30 transition-colors"
                    >
                      {/* 利用者名 / フリガナ */}
                      <td className="sticky left-0 bg-white border-r border-gray-200 px-2 py-1.5 whitespace-nowrap">
                        <button
                          onClick={() => setEditTarget(claim)}
                          className="text-left hover:underline"
                          title="詳細編集"
                        >
                          <div className="text-[10px] text-gray-400 leading-tight">
                            {user?.name_kana ?? ""}
                          </div>
                          <div className="font-medium text-gray-900 leading-tight">
                            {user?.name ?? "—"}
                          </div>
                        </button>
                      </td>
                      {/* 性別 */}
                      <td className="border-r border-gray-200 px-1 py-1.5 text-center whitespace-nowrap">
                        <span className={user?.gender === "女" ? "text-pink-600" : "text-blue-600"}>
                          {user?.gender ?? "—"}
                        </span>
                      </td>
                      {/* 電話番号 */}
                      <td className="border-r border-gray-200 px-2 py-1.5 text-gray-600 whitespace-nowrap">
                        {user?.phone || user?.mobile_phone ? (
                          <>
                            <div className="text-[10px] leading-tight">{user?.phone ?? ""}</div>
                            <div className="text-[10px] leading-tight text-gray-400">{user?.mobile_phone ?? ""}</div>
                          </>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      {/* 要介護度 */}
                      <td className="border-r border-gray-200 px-1 py-1.5 text-center whitespace-nowrap">
                        <span className="rounded bg-purple-50 px-1 py-0.5 text-[10px] font-medium text-purple-700">
                          {certEntry?.care_level?.replace("要介護", "介").replace("要支援", "支") ?? "—"}
                        </span>
                      </td>
                      {/* 予防支援区分 (要支援のみ select) */}
                      <td className="border-r border-gray-200 px-1 py-1.5 text-center">
                        {isYoboShienLevel(certEntry?.care_level) ? (
                          <select
                            value={parseYoboShienKubun(claim.notes) ?? "II"}
                            disabled={disabled /* 委託行でも区分は変更可 */}
                            onChange={(e) =>
                              handleYoboKubunChange(claim, e.target.value as YoboShienKubun)
                            }
                            className={inputCls}
                            title="Ⅰ=地域包括支援センター / Ⅱ=居宅介護支援事業者の指定 / 委託=包括が請求 (請求対象外)"
                          >
                            <option value="I">Ⅰ 包括</option>
                            <option value="II">Ⅱ 指定</option>
                            <option value="itaku">委託</option>
                          </select>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      {/* 初回加算 (checkbox) */}
                      <td className="border-r border-gray-200 px-1 py-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={claim.initial_addition}
                          disabled={addonDisabled}
                          onChange={(e) =>
                            handleQuickPatch(claim, { initial: e.target.checked })
                          }
                          className="h-4 w-4 accent-blue-600 cursor-pointer disabled:cursor-not-allowed"
                        />
                      </td>
                      {/* 退院・退所加算 (dropdown) */}
                      <td className="border-r border-gray-200 px-1 py-1.5">
                        <select
                          value={claim.discharge_type ?? "none"}
                          disabled={addonDisabled}
                          onChange={(e) =>
                            handleQuickPatch(claim, { discharge: e.target.value as DischargeType })
                          }
                          className={inputCls}
                        >
                          <option value="none">—</option>
                          <option value="i_i">(i)イ</option>
                          <option value="i_ro">(i)ロ</option>
                          <option value="ii_i">(ii)イ</option>
                          <option value="ii_ro">(ii)ロ</option>
                          <option value="iii">(iii)</option>
                        </select>
                      </td>
                      {/* 入院時情報連携加算 (dropdown) */}
                      <td className="border-r border-gray-200 px-1 py-1.5">
                        <select
                          value={(() => {
                            if (!claim.hospital_coordination) return "none";
                            return claim.hospital_coordination_units >= 250 ? "i" : "ii";
                          })()}
                          disabled={addonDisabled}
                          onChange={(e) =>
                            handleQuickPatch(claim, { hospitalization: e.target.value as HospitalCoordType })
                          }
                          className={inputCls}
                        >
                          <option value="none">—</option>
                          <option value="i">Ⅰ</option>
                          <option value="ii">Ⅱ</option>
                        </select>
                      </td>
                      {/* 緊急時等カンファ (checkbox) */}
                      <td className="border-r border-gray-200 px-1 py-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={claim.emergency_conference ?? false}
                          disabled={addonDisabled}
                          onChange={(e) =>
                            handleQuickPatch(claim, { emergency_conference: e.target.checked })
                          }
                          className="h-4 w-4 accent-blue-600 cursor-pointer disabled:cursor-not-allowed"
                        />
                      </td>
                      {/* ターミナルケア (checkbox) */}
                      <td className="border-r border-gray-200 px-1 py-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={claim.terminal_care ?? false}
                          disabled={addonDisabled}
                          onChange={(e) =>
                            handleQuickPatch(claim, { terminal_care: e.target.checked })
                          }
                          className="h-4 w-4 accent-blue-600 cursor-pointer disabled:cursor-not-allowed"
                        />
                      </td>
                      {/* 通院時情報連携加算 (checkbox) */}
                      <td className="border-r border-gray-200 px-1 py-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={claim.medical_coordination}
                          disabled={addonDisabled}
                          onChange={(e) =>
                            handleQuickPatch(claim, { outpatient: e.target.checked })
                          }
                          className="h-4 w-4 accent-blue-600 cursor-pointer disabled:cursor-not-allowed"
                        />
                      </td>
                      {/* 特定事業所医療介護連携 (checkbox) */}
                      <td className="border-r border-gray-200 px-1 py-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={claim.medical_coop_kassan ?? false}
                          disabled={addonDisabled}
                          onChange={(e) =>
                            handleQuickPatch(claim, { medical_coop_kassan: e.target.checked })
                          }
                          className="h-4 w-4 accent-blue-600 cursor-pointer disabled:cursor-not-allowed"
                        />
                      </td>
                      {/* 業務継続計画未策定減算 (checkbox) */}
                      <td className="border-r border-gray-200 px-1 py-1.5 text-center bg-red-50/20">
                        <input
                          type="checkbox"
                          checked={claim.bcp_not_prepared ?? false}
                          disabled={addonDisabled}
                          onChange={(e) =>
                            handleQuickPatch(claim, { bcp_not_prepared: e.target.checked })
                          }
                          className="h-4 w-4 accent-red-600 cursor-pointer disabled:cursor-not-allowed"
                        />
                      </td>
                      {/* 虐待防止措置未実施減算 (checkbox) */}
                      <td className="border-r border-gray-200 px-1 py-1.5 text-center bg-red-50/20">
                        <input
                          type="checkbox"
                          checked={claim.abuse_prevention_not_implemented ?? false}
                          disabled={addonDisabled}
                          onChange={(e) =>
                            handleQuickPatch(claim, { abuse_prevention_not_implemented: e.target.checked })
                          }
                          className="h-4 w-4 accent-red-600 cursor-pointer disabled:cursor-not-allowed"
                        />
                      </td>
                      {/* 単位数（基本+加算-減算） */}
                      <td className="border-r border-gray-200 px-2 py-1.5 text-right text-gray-800 whitespace-nowrap tabular-nums">
                        {(() => {
                          let total = claim.units;
                          if (claim.initial_addition) total += claim.initial_addition_units;
                          if (claim.tokutei_kassan_units) total += claim.tokutei_kassan_units;
                          if (claim.medical_coop_kassan) total += (claim.medical_coop_kassan_units ?? 125);
                          if (claim.hospital_coordination) total += claim.hospital_coordination_units;
                          if (claim.discharge_addition) total += claim.discharge_addition_units;
                          if (claim.medical_coordination) total += (claim.medical_coordination_units ?? 50);
                          if (claim.terminal_care) total += (claim.terminal_care_units ?? 400);
                          if (claim.emergency_conference) total += (claim.emergency_conference_units ?? 200);
                          return total.toLocaleString("ja-JP");
                        })()}
                      </td>
                      {/* 請求額 */}
                      <td className="border-r border-gray-200 px-2 py-1.5 text-right font-semibold text-blue-700 whitespace-nowrap">
                        {parseYoboShienKubun(claim.notes) === "itaku" ? (
                          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                            請求対象外
                          </span>
                        ) : (
                          formatAmount(claim.insurance_amount)
                        )}
                      </td>
                      {/* 状態 + 操作 */}
                      <td className="px-2 py-1.5 text-center whitespace-nowrap">
                        <div className="flex items-center justify-center gap-1">
                          <span
                            className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STATUS_COLORS[claim.status]}`}
                          >
                            {STATUS_LABELS[claim.status]}
                          </span>
                          {claim.status === "draft" ? (
                            <button
                              onClick={() => handleSetStatus(claim.id, "confirmed")}
                              className="rounded p-0.5 text-green-500 hover:bg-green-50 hover:text-green-700 transition-colors"
                              title="確定"
                            >
                              <Check size={12} />
                            </button>
                          ) : claim.status === "confirmed" ? (
                            <button
                              onClick={() => handleSetStatus(claim.id, "draft")}
                              className="rounded p-0.5 text-yellow-500 hover:bg-yellow-50 hover:text-yellow-700 transition-colors"
                              title="取消"
                            >
                              <X size={12} />
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>

              {/* Footer totals */}
              {claims.length > 0 && (
                <tfoot className="border-t-2 border-gray-300 bg-gray-100">
                  <tr>
                    <td
                      colSpan={14}
                      className="px-2 py-2 text-xs font-medium text-gray-700 text-right"
                    >
                      合計 ({claims.length}件)
                    </td>
                    <td className="px-2 py-2 text-right text-sm font-bold text-gray-800 whitespace-nowrap tabular-nums">
                      {claims.reduce((s, c) => {
                        let t = c.units;
                        if (c.initial_addition) t += c.initial_addition_units;
                        if (c.tokutei_kassan_units) t += c.tokutei_kassan_units;
                        if (c.medical_coop_kassan) t += (c.medical_coop_kassan_units ?? 125);
                        if (c.hospital_coordination) t += c.hospital_coordination_units;
                        if (c.discharge_addition) t += c.discharge_addition_units;
                        if (c.medical_coordination) t += (c.medical_coordination_units ?? 50);
                        if (c.terminal_care) t += (c.terminal_care_units ?? 400);
                        if (c.emergency_conference) t += (c.emergency_conference_units ?? 200);
                        return s + t;
                      }, 0).toLocaleString("ja-JP")}
                    </td>
                    <td className="px-2 py-2 text-right text-sm font-bold text-blue-700 whitespace-nowrap">
                      {formatAmount(
                        claims.reduce((s, c) => s + c.insurance_amount, 0)
                      )}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>

      {/* Footer note */}
      <p className="text-xs text-gray-400">
        ※ 居宅介護支援費・介護予防支援費は10割給付のため利用者負担額は0円です。国保連CSV出力は確定済みレセプトのみ対象です。
        予防支援区分「委託」(= 地域包括支援センターが請求) の利用者は請求対象外となり、CSV・伝送出力に含まれません。
      </p>
    </div>
  );
}
