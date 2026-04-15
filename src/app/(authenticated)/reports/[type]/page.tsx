"use client";

import { useParams } from "next/navigation";
import React, { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  Printer, Loader2, AlertTriangle, FileText, Plus, ChevronLeft, ChevronRight,
  Save, CheckCircle, Clock, Pencil, X, CalendarDays,
} from "lucide-react";
import Link from "next/link";
import { UserSidebar } from "@/components/users/user-sidebar";
import { ServiceSelector } from "@/components/services/service-selector";
import { format, parseISO, differenceInYears } from "date-fns";
import { ja } from "date-fns/locale";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ReportDoc = {
  id: string;
  user_id: string;
  certification_id: string | null;
  report_type: string;
  title: string;
  report_month: string | null;
  care_plan_id: string | null;
  content: Record<string, unknown>;
  status: "draft" | "completed";
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type Certification = {
  id: string;
  care_level: string;
  start_date: string;
  end_date: string;
};

type KaigoUser = {
  id: string; name: string; name_kana: string; gender: string;
  birth_date: string; blood_type: string | null; postal_code: string | null;
  address: string | null; phone: string | null; mobile_phone: string | null;
  emergency_contact_name: string | null; emergency_contact_phone: string | null;
  admission_date: string | null; notes: string | null;
};

type CareCertification = {
  id: string; care_level: string; start_date: string; end_date: string;
  certification_number: string | null; insurer_number: string | null;
  insured_number: string | null; support_limit_amount: number | null; status: string;
};

type CarePlan = {
  id: string; plan_number: string; plan_type: string;
  start_date: string; end_date: string;
  long_term_goals: string | null; short_term_goals: string | null;
  status: string; created_by: string | null;
};

type CarePlanService = {
  id: string; service_type: string; service_content: string;
  frequency: string | null; provider: string | null;
  start_date: string | null; end_date: string | null; notes: string | null;
};

// ---------------------------------------------------------------------------
// Report config
// ---------------------------------------------------------------------------

type ReportConfig = { titleJa: string; needsPeriod: boolean; landscape?: boolean };

const REPORT_CONFIG: Record<string, ReportConfig> = {
  "care-plan-1":       { titleJa: "居宅サービス計画書（第1表）",        needsPeriod: false, landscape: true },
  "care-plan-2":       { titleJa: "居宅サービス計画書（第2表）",        needsPeriod: false, landscape: true },
  "care-plan-3":       { titleJa: "週間サービス計画表（第3表）",        needsPeriod: false, landscape: true },
  "support-progress":  { titleJa: "居宅介護支援経過（第5表）",          needsPeriod: true,  landscape: true },
  "service-usage":        { titleJa: "利用票・提供票",                    needsPeriod: true,  landscape: true },
  "service-usage-detail": { titleJa: "サービス利用票別表",                needsPeriod: true,  landscape: true },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(d: string | null | undefined): string {
  if (!d) return "　";
  try { return format(parseISO(d), "yyyy年M月d日", { locale: ja }); } catch { return d; }
}

function fmtReiwa(d: string | null | undefined): string {
  if (!d) return "　　年　月　日";
  try {
    const date = parseISO(d);
    const y = date.getFullYear(), m = date.getMonth() + 1, day = date.getDate();
    if (y >= 2019) return `令和${y - 2018}年${m}月${day}日`;
    if (y >= 1989) return `平成${y - 1988}年${m}月${day}日`;
    return `${y}年${m}月${day}日`;
  } catch { return d ?? "　"; }
}

function fmtReiwaMonth(ym: string | null | undefined): string {
  if (!ym) return "　　年　月";
  try {
    const d = parseISO(ym + (ym.length === 7 ? "-01" : ""));
    const y = d.getFullYear(), m = d.getMonth() + 1;
    if (y >= 2019) return `令和${y - 2018}年${m}月`;
    if (y >= 1989) return `平成${y - 1988}年${m}月`;
    return `${y}年${m}月`;
  } catch { return ym; }
}

function calcAge(birthDate: string): string {
  try { return `${differenceInYears(new Date(), parseISO(birthDate))}歳`; } catch { return "　"; }
}

function fmtJaYear(d: string | null | undefined): string {
  if (!d) return "　";
  try { return format(parseISO(d), "yyyy年M月", { locale: ja }); } catch { return d ?? "　"; }
}

const CARE_LEVELS = ["要支援１","要支援２","要介護１","要介護２","要介護３","要介護４","要介護５"];

// ---------------------------------------------------------------------------
// Table cell components
// ---------------------------------------------------------------------------

const TH = ({ children, className = "", colSpan, rowSpan, style }: {
  children?: React.ReactNode; className?: string;
  colSpan?: number; rowSpan?: number; style?: React.CSSProperties;
}) => (
  <th colSpan={colSpan} rowSpan={rowSpan} style={style}
    className={`border border-black bg-gray-100 text-center text-xs font-medium leading-tight ${className}`}>
    {children}
  </th>
);

const TD = ({ children, className = "", colSpan, rowSpan, style }: {
  children?: React.ReactNode; className?: string;
  colSpan?: number; rowSpan?: number; style?: React.CSSProperties;
}) => (
  <td colSpan={colSpan} rowSpan={rowSpan} style={style}
    className={`border border-black text-xs leading-tight ${className}`}>
    {children ?? "　"}
  </td>
);

// ---------------------------------------------------------------------------
// Input helpers for edit mode
// ---------------------------------------------------------------------------

function FI({ label, value, onChange, textarea, rows = 3, className = "" }: {
  label: string; value: string; onChange: (v: string) => void;
  textarea?: boolean; rows?: number; className?: string;
}) {
  return (
    <div className={`flex flex-col gap-0.5 ${className}`}>
      <label className="text-xs font-medium text-gray-500">{label}</label>
      {textarea ? (
        <textarea rows={rows} value={value} onChange={(e) => onChange(e.target.value)}
          className="rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
      ) : (
        <input type="text" value={value} onChange={(e) => onChange(e.target.value)}
          className="rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
      )}
    </div>
  );
}

// ── Provider/Type Linked Selector (マスタ連動) ──────────────────────────────
// 種別⇔事業所が双方向に連動する選択フィールド
type ProviderRow = { id: string; provider_name: string; service_categories: string[] };
type CategoryRow = { code: string; name: string };

// 介護保険サービス種別の標準マスタ（種類コード順）
const STANDARD_SERVICE_CATEGORIES: CategoryRow[] = [
  { code: "11", name: "訪問介護" },
  { code: "12", name: "訪問入浴介護" },
  { code: "13", name: "訪問看護" },
  { code: "14", name: "訪問リハビリテーション" },
  { code: "15", name: "通所介護" },
  { code: "16", name: "通所リハビリテーション" },
  { code: "17", name: "福祉用具貸与" },
  { code: "21", name: "短期入所生活介護" },
  { code: "22", name: "短期入所療養介護" },
  { code: "23", name: "特定施設入居者生活介護" },
  { code: "24", name: "福祉用具購入" },
  { code: "25", name: "住宅改修" },
  { code: "31", name: "居宅療養管理指導" },
  { code: "32", name: "介護老人福祉施設" },
  { code: "33", name: "介護老人保健施設" },
  { code: "34", name: "介護療養型医療施設" },
  { code: "36", name: "認知症対応型共同生活介護" },
  { code: "43", name: "居宅介護支援" },
  { code: "46", name: "介護予防支援" },
  { code: "71", name: "定期巡回・随時対応型訪問介護看護" },
  { code: "72", name: "夜間対応型訪問介護" },
  { code: "73", name: "認知症対応型通所介護" },
  { code: "74", name: "小規模多機能型居宅介護" },
  { code: "75", name: "看護小規模多機能型居宅介護" },
  { code: "76", name: "地域密着型通所介護" },
  { code: "77", name: "地域密着型特定施設入居者生活介護" },
  { code: "78", name: "地域密着型介護老人福祉施設入所者生活介護" },
  { code: "A1", name: "訪問型サービス(総合事業)" },
  { code: "A2", name: "通所型サービス(総合事業)" },
  { code: "A3", name: "その他生活支援サービス(総合事業)" },
];

// モジュールレベルでキャッシュ（複数のインスタンスで共有）
let __providerCache: ProviderRow[] | null = null;
let __categoryCache: CategoryRow[] | null = null;
let __cacheLoading: Promise<void> | null = null;

async function loadProviderMasterCache() {
  if (__providerCache && __categoryCache) return;
  if (__cacheLoading) { await __cacheLoading; return; }
  __cacheLoading = (async () => {
    const supabase = createClient();
    const [{ data: provs }, { data: codes }] = await Promise.all([
      supabase.from("kaigo_service_providers").select("id, provider_name, service_categories").eq("status", "active").order("provider_name"),
      supabase.from("kaigo_service_codes").select("service_category, service_category_name"),
    ]);
    __providerCache = (provs || []) as ProviderRow[];

    // 標準マスタ + DBから取得した種別をマージ（DBにないものは標準を使う）
    const catMap = new Map<string, string>();
    STANDARD_SERVICE_CATEGORIES.forEach((c) => catMap.set(c.code, c.name));
    (codes || []).forEach((c: Record<string, unknown>) => {
      catMap.set(String(c.service_category), String(c.service_category_name));
    });
    __categoryCache = Array.from(catMap.entries()).map(([code, name]) => ({ code, name }))
      .sort((a, b) => a.code.localeCompare(b.code));
  })();
  await __cacheLoading;
  __cacheLoading = null;
}

function ProviderTypeSelector({ type, provider, onTypeChange, onProviderChange }: {
  type: string; provider: string;
  onTypeChange: (v: string) => void;
  onProviderChange: (v: string) => void;
}) {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    loadProviderMasterCache().then(() => {
      if (cancelled) return;
      setProviders(__providerCache ?? []);
      setCategories(__categoryCache ?? []);
    });
    return () => { cancelled = true; };
  }, []);

  // 現在の種別（名前）から対応するcategoryコードを逆引き
  const currentCatCode = categories.find((c) => c.name === type)?.code ?? "";

  // 種別でフィルタされた事業所一覧
  const filteredProviders = currentCatCode
    ? providers.filter((p) => (p.service_categories || []).includes(currentCatCode))
    : providers;

  // 事業所から利用可能な種別一覧を逆引き
  const currentProvider = providers.find((p) => p.provider_name === provider);
  const providerAvailableCats = currentProvider?.service_categories ?? [];

  // 事業所選択時: 種別が未選択 or 対象事業所が持たない種別なら、最初の種別を自動設定
  const handleProviderChange = (newProvider: string) => {
    onProviderChange(newProvider);
    const prv = providers.find((p) => p.provider_name === newProvider);
    if (prv && prv.service_categories && prv.service_categories.length > 0) {
      if (!type || !prv.service_categories.includes(currentCatCode)) {
        const firstCatCode = prv.service_categories[0];
        const firstCat = categories.find((c) => c.code === firstCatCode);
        if (firstCat) onTypeChange(firstCat.name);
      }
    }
  };

  const handleTypeChange = (newType: string) => {
    onTypeChange(newType);
    // 種別を変えたとき、現在の事業所がその種別を持っていなければクリア
    const newCatCode = categories.find((c) => c.name === newType)?.code ?? "";
    if (currentProvider && newCatCode && !currentProvider.service_categories.includes(newCatCode)) {
      onProviderChange("");
    }
  };

  return (
    <>
      {/* サービス種別 */}
      <div className="flex flex-col gap-0.5">
        <label className="text-xs font-medium text-gray-500">サービス種別</label>
        <select
          value={type}
          onChange={(e) => handleTypeChange(e.target.value)}
          className="rounded border border-gray-300 px-1 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
        >
          <option value="">—</option>
          {categories.map((c) => {
            // 事業所が選択されている場合、その事業所が持つ種別のみ濃色、他はグレー
            const available = providerAvailableCats.length === 0 || providerAvailableCats.includes(c.code);
            return (
              <option key={c.code} value={c.name} style={{ color: available ? "inherit" : "#999" }}>
                {c.name}{!available && providerAvailableCats.length > 0 ? " (該当なし)" : ""}
              </option>
            );
          })}
          {/* 現在の値がマスタにない場合の保持 */}
          {type && !categories.some((c) => c.name === type) && (
            <option value={type}>{type}（手入力）</option>
          )}
        </select>
      </div>
      {/* 事業所 */}
      <div className="flex flex-col gap-0.5">
        <label className="text-xs font-medium text-gray-500">※2 事業所</label>
        <select
          value={provider}
          onChange={(e) => handleProviderChange(e.target.value)}
          className="rounded border border-gray-300 px-1 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
        >
          <option value="">—</option>
          {filteredProviders.map((p) => (
            <option key={p.id} value={p.provider_name}>{p.provider_name}</option>
          ))}
          {/* 現在の値がフィルタ外・マスタ外の場合の保持 */}
          {provider && !filteredProviders.some((p) => p.provider_name === provider) && (
            <option value={provider}>{provider}{providers.some((p) => p.provider_name === provider) ? "（種別外）" : "（手入力）"}</option>
          )}
        </select>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared types and helpers for edit/print components
// ---------------------------------------------------------------------------

type FamilyRow = { name: string; relationship: string; phone: string; key_person: boolean };
type MedRow = { disease: string; hospital: string; status: string };
type Schedule = Record<string, Record<string, string>>;
type SvcRow = { time: string; content: string; provider: string; planned: boolean[]; actual: boolean[] };
type InvoiceItem = { content: string; units: number; unit_price: number; amount: number };

const WEEK_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const WEEK_DAY_JA = ["月", "火", "水", "木", "金", "土", "日"] as const;

/**
 * 第3表の時間行（公式様式準拠）
 * - 2時間刻み×12行（0:00〜22:00 の開始時刻を持つ時間帯）
 * - 各行は periodLabel の区分にまとまり、先頭行のみ periodSpan を持つ
 * - key は h00..h22（新形式）
 */
const CARE_PLAN3_TIME_ROWS: ReadonlyArray<{
  key: string;
  time: string;        // 行の開始時刻表示
  period?: string;     // 深夜 / 早朝 / 午前 / 午後 / 夜間
  periodSpan?: number; // rowSpan 数（区分の先頭行のみ）
}> = [
  { key: "h00", time: "0:00",  period: "深夜", periodSpan: 3 },
  { key: "h02", time: "2:00" },
  { key: "h04", time: "4:00" },
  { key: "h06", time: "6:00",  period: "早朝", periodSpan: 1 },
  { key: "h08", time: "8:00",  period: "午前", periodSpan: 2 },
  { key: "h10", time: "10:00" },
  { key: "h12", time: "12:00", period: "午後", periodSpan: 3 },
  { key: "h14", time: "14:00" },
  { key: "h16", time: "16:00" },
  { key: "h18", time: "18:00", period: "夜間", periodSpan: 2 },
  { key: "h20", time: "20:00" },
  { key: "h22", time: "22:00", period: "深夜", periodSpan: 1 },
];

/** 旧5区分形式との互換: 既存 schedule から新形式セルを取得 */
function getSchedCell(schedule: Schedule, rowKey: string, day: string): string {
  if (schedule[rowKey]?.[day]) return schedule[rowKey][day];
  const hour = parseInt(rowKey.replace("h", ""), 10);
  if (Number.isNaN(hour)) return "";
  if (hour < 6  && schedule.early_morning?.[day]) return schedule.early_morning[day];
  if (hour >= 6  && hour < 12 && schedule.morning?.[day])   return schedule.morning[day];
  if (hour >= 12 && hour < 18 && schedule.afternoon?.[day]) return schedule.afternoon[day];
  if (hour >= 18 && hour < 21 && schedule.evening?.[day])   return schedule.evening[day];
  if (hour >= 21 && schedule.night?.[day])                   return schedule.night[day];
  return "";
}

function emptySchedule(): Schedule {
  const s: Schedule = {};
  for (const row of CARE_PLAN3_TIME_ROWS) {
    s[row.key] = {};
    for (const d of WEEK_DAYS) s[row.key][d] = "";
  }
  return s;
}

// 旧コードからの参照を維持（auto-generate時に使われている）
const TIME_SLOTS = CARE_PLAN3_TIME_ROWS.map((r) => ({ key: r.key, label: r.time }));

function emptyServiceRow(): SvcRow {
  return { time: "", content: "", provider: "", planned: Array(31).fill(false), actual: Array(31).fill(false) };
}

// ---------------------------------------------------------------------------
// Default content builders (for auto-generation)
// ---------------------------------------------------------------------------

function buildDefaultContent(
  reportType: string,
  user: KaigoUser,
  cert: CareCertification | null,
  plan: CarePlan | null,
  services: CarePlanService[],
  reportMonth: string | null = null,
): Record<string, unknown> {
  const today = format(new Date(), "yyyy-MM-dd");
  switch (reportType) {
    case "care-plan-1":
      return {
        plan_type: plan?.plan_type ?? "継続",
        cert_status: cert ? "認定済" : "申請中",
        user_name: user.name,
        birth_date: user.birth_date ?? "",
        address: [user.postal_code ? `〒${user.postal_code}` : "", user.address ?? ""].filter(Boolean).join(" "),
        care_level: cert?.care_level ?? "",
        cert_period: cert ? `${fmtReiwa(cert.start_date)}　〜　${fmtReiwa(cert.end_date)}` : "",
        creator_name: "",
        office_name: "",
        creation_date: fmtReiwa(plan?.start_date ?? today),
        initial_creation_date: fmtReiwa(plan?.start_date ?? null),
        issue_analysis: plan?.long_term_goals ?? "",
        review_opinion: "",
        overall_policy: plan?.short_term_goals ?? "",
        living_support_reason: "",
      };
    case "care-plan-2": {
      const planPeriod = plan ? `${fmtReiwa(plan.start_date)}〜${fmtReiwa(plan.end_date)}` : "";
      return {
        user_name: user.name,
        creation_date: fmtReiwa(plan?.start_date ?? today),
        blocks: [{
          needs: plan?.long_term_goals ?? "",
          long_term_goal: plan?.long_term_goals ?? "",
          long_term_period: planPeriod,
          goals: [{
            short_term_goal: plan?.short_term_goals ?? "",
            short_term_period: planPeriod,
            services: services.map((sv) => ({
              content: sv.service_content,
              insurance_flag: "○",
              type: sv.service_type,
              provider: sv.provider ?? "",
              frequency: sv.frequency ?? "",
              period: planPeriod,
            })),
          }],
        }] as NeedsBlock[],
      };
    }
    case "care-plan-3": {
      const sch = emptySchedule();
      // サービスを午前（h10: 10:00〜12:00）の時間帯に自動配置
      const DEFAULT_ROW = "h10";
      const appendCell = (row: string, day: string, text: string) => {
        if (!sch[row]) sch[row] = {};
        sch[row][day] = (sch[row][day] ? sch[row][day] + "\n" : "") + text;
      };
      services.forEach((sv) => {
        const text = `${sv.service_type}（${sv.service_content}）`;
        const freq = sv.frequency ?? "";
        if (freq.includes("毎日") || freq.includes("週7")) {
          WEEK_DAYS.forEach((d) => appendCell(DEFAULT_ROW, d, text));
        } else if (freq.includes("週3")) {
          ["mon", "wed", "fri"].forEach((d) => appendCell(DEFAULT_ROW, d, text));
        } else if (freq.includes("週2")) {
          ["tue", "thu"].forEach((d) => appendCell(DEFAULT_ROW, d, text));
        } else if (freq.includes("週1")) {
          appendCell(DEFAULT_ROW, "mon", text);
        }
      });
      return {
        user_name: user.name,
        creation_date: fmtReiwa(plan?.start_date ?? today),
        care_level: cert?.care_level ?? "",
        plan_period: plan ? `${fmtReiwa(plan.start_date)}〜${fmtReiwa(plan.end_date)}` : "",
        schedule: sch,
        daily_activities: "起床・洗面・着替え　／　食事（朝・昼・夕）　／　レクリエーション　／　入浴　／　就寝",
        other_services: services.filter((s) => s.service_type.includes("福祉用具")).map((s) => s.service_content).join("\n"),
      };
    }
    case "support-progress":
      return {
        user_name: user.name,
        creation_date: fmtReiwa(plan?.start_date ?? today),
        creator_name: plan?.created_by ?? "",
        entries: [],
      };
    case "service-usage":
      return {
        insurer_number: cert?.insurer_number ?? "",
        insured_number: cert?.insured_number ?? "",
        insurer_name: "",
        user_name: user.name,
        care_level: cert?.care_level ?? "",
        limit_amount: cert?.support_limit_amount ?? 0,
        limit_period: cert ? `${fmtReiwa(cert.start_date)}〜${fmtReiwa(cert.end_date)}` : "",
        creation_date: fmtReiwa(today),
        submission_date: "",
        services: services.slice(0, 9).map((sv) => ({
          time: sv.frequency ?? "",
          content: sv.service_content,
          provider: sv.provider ?? "",
          planned: Array(31).fill(false) as boolean[],
          actual:  Array(31).fill(false) as boolean[],
        })),
      };
    case "service-usage-detail":
      return {
        creation_date: fmtReiwa(today),
        user_name: user.name,
        insurer_number: cert?.insurer_number ?? "",
        insured_number: cert?.insured_number ?? "",
        care_level: cert?.care_level ?? "",
        limit_amount: cert?.support_limit_amount ?? 0,
        limit_period: cert ? `${fmtReiwa(cert.start_date)}〜${fmtReiwa(cert.end_date)}` : "",
        items: services.map((sv) => ({
          provider_name: sv.provider ?? "",
          provider_number: "",
          service_content: sv.service_content,
          service_code: "",
          units: 0,
          discount_units: 0,
          count: 0,
          service_units: 0,
          over_type_units: 0,
          over_limit_units: 0,
          within_limit_units: 0,
          unit_price: 10.00,
          total_cost: 0,
          benefit_rate: 90,
          insurance_claim: 0,
          fixed_copay: 0,
          user_copay: 0,
          user_full_pay: 0,
        })),
        limit_management: [] as { service_type: string; limit: number; total_units: number; over_units: number }[],
        short_stay_days: { prev: 0, current: 0, total: 0 },
      };
    default:
      return { notes: "", created_from: "auto" };
  }
}

// ---------------------------------------------------------------------------
// Edit Forms per report type
// ---------------------------------------------------------------------------

function EditFormCarePlan1({ content, onChange }: {
  content: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
}) {
  const s = (key: string) => (String(content[key] ?? ""));
  const set = (key: string, v: string) => onChange({ ...content, [key]: v });
  return (
    <div className="grid grid-cols-2 gap-3 p-4">
      <div className="col-span-2 grid grid-cols-4 gap-3">
        <FI label="初回・紹介・継続" value={s("plan_type")} onChange={(v) => set("plan_type", v)} />
        <FI label="認定済・申請中" value={s("cert_status")} onChange={(v) => set("cert_status", v)} />
        <FI label="作成者氏名" value={s("creator_name")} onChange={(v) => set("creator_name", v)} />
        <FI label="事業所名" value={s("office_name")} onChange={(v) => set("office_name", v)} />
      </div>
      <div className="col-span-2 grid grid-cols-4 gap-3">
        <FI label="利用者名" value={s("user_name")} onChange={(v) => set("user_name", v)} />
        <FI label="生年月日" value={s("birth_date")} onChange={(v) => set("birth_date", v)} />
        <FI label="住所" value={s("address")} onChange={(v) => set("address", v)} className="col-span-2" />
      </div>
      <div className="col-span-2 grid grid-cols-4 gap-3">
        <FI label="要介護度" value={s("care_level")} onChange={(v) => set("care_level", v)} />
        <FI label="認定有効期間" value={s("cert_period")} onChange={(v) => set("cert_period", v)} />
        <FI label="計画作成（変更）日" value={s("creation_date")} onChange={(v) => set("creation_date", v)} />
        <FI label="初回計画作成日" value={s("initial_creation_date")} onChange={(v) => set("initial_creation_date", v)} />
      </div>
      <FI label="利用者及び家族の生活に対する意向を踏まえた課題分析の結果" value={s("issue_analysis")}
        onChange={(v) => set("issue_analysis", v)} textarea rows={4} className="col-span-2" />
      <FI label="介護認定審査会の意見及びサービスの種類の指定" value={s("review_opinion")}
        onChange={(v) => set("review_opinion", v)} textarea rows={3} className="col-span-2" />
      <FI label="総合的な援助の方針" value={s("overall_policy")}
        onChange={(v) => set("overall_policy", v)} textarea rows={4} className="col-span-2" />
      <FI label="生活援助中心型の算定理由" value={s("living_support_reason")}
        onChange={(v) => set("living_support_reason", v)} className="col-span-2" />
    </div>
  );
}

// 第2表のデータ構造: ニーズ → 複数の目標・サービス
type NeedsBlock = {
  needs: string;
  long_term_goal: string;
  long_term_period: string;
  goals: {
    short_term_goal: string;
    short_term_period: string;
    services: { content: string; insurance_flag: string; type: string; provider: string; frequency: string; period: string }[];
  }[];
};

function EditFormCarePlan2({ content, onChange }: {
  content: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
}) {
  const s = (key: string) => String(content[key] ?? "");
  const set = (key: string, v: unknown) => onChange({ ...content, [key]: v });
  const supabaseForAi = createClient();

  // AI生成
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiMode, setAiMode] = useState<"from-services" | "from-services-grouped" | "full">("from-services-grouped");

  useEffect(() => {
    const checkAi = async () => {
      const { data } = await supabaseForAi.from("kaigo_office_settings").select("ai_enabled, ai_api_key").limit(1).single();
      if (data) {
        setAiEnabled(!!data.ai_enabled);
        setAiApiKey(String(data.ai_api_key ?? ""));
      }
    };
    checkAi();
  }, [supabaseForAi]);

  const handleAiGenerate = async () => {
    if (!aiApiKey) { toast.error("APIキーが設定されていません。マスタ管理→自事業所設定で設定してください。"); return; }
    setAiGenerating(true);
    try {
      // 利用者情報を取得（contentからuser_nameを使ってDBから取得）
      const userName = s("user_name");
      const { data: users } = await supabaseForAi.from("kaigo_users").select("*").eq("name", userName).limit(1);
      const user = users?.[0];
      const userId = user?.id;

      let adlSummary = "";
      let medicalHistory = "";
      let familySituation = "";
      let careLevel = "";

      if (userId) {
        const { data: adl } = await supabaseForAi.from("kaigo_adl_records").select("*").eq("user_id", userId).order("assessment_date", { ascending: false }).limit(1);
        if (adl?.[0]) {
          const a = adl[0];
          adlSummary = `食事:${a.eating} 移乗:${a.transfer} 整容:${a.grooming} トイレ:${a.toilet} 入浴:${a.bathing} 移動:${a.mobility} 階段:${a.stairs} 更衣:${a.dressing} 排便:${a.bowel} 排尿:${a.bladder} 合計:${a.total_score}/100`;
        }
        const { data: history } = await supabaseForAi.from("kaigo_medical_history").select("disease_name, status").eq("user_id", userId);
        medicalHistory = (history || []).map((h: Record<string, unknown>) => `${h.disease_name}(${h.status})`).join("、");
        const { data: family } = await supabaseForAi.from("kaigo_family_contacts").select("name, relationship").eq("user_id", userId);
        familySituation = (family || []).map((f: Record<string, unknown>) => `${f.relationship}:${f.name}`).join("、");
        const { data: cert } = await supabaseForAi.from("kaigo_care_certifications").select("care_level").eq("user_id", userId).eq("status", "active").limit(1);
        careLevel = cert?.[0]?.care_level ?? "";
      }

      // 現在のサービス一覧
      const currentServices = (Array.isArray(content.blocks) ? content.blocks as NeedsBlock[] : [])
        .flatMap((b) => b.goals.flatMap((g) => g.services))
        .filter((sv) => sv.content || sv.type)
        .map((sv) => ({ type: sv.type, content: sv.content, frequency: sv.frequency, provider: sv.provider }));

      const res = await fetch("/api/ai/generate-care-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: aiApiKey,
          mode: aiMode,
          userInfo: {
            name: userName,
            age: user?.birth_date ? String(differenceInYears(new Date(), parseISO(user.birth_date))) : "",
            gender: user?.gender ?? "",
            careLevel,
            medicalHistory,
            adlSummary,
            familySituation,
            notes: user?.notes ?? "",
          },
          services: currentServices,
        }),
      });

      const result = await res.json();
      if (!res.ok || result.error) {
        toast.error("AI生成エラー: " + (result.error || "不明なエラー"));
        return;
      }

      // 生成結果をフォームに反映
      const aiBlocks = result.data?.blocks;
      if (aiBlocks && Array.isArray(aiBlocks)) {
        const newBlocks: NeedsBlock[] = aiBlocks.map((ab: Record<string, unknown>) => ({
          needs: String(ab.needs ?? ""),
          long_term_goal: String(ab.long_term_goal ?? ""),
          long_term_period: "",
          goals: [{
            short_term_goal: String(ab.short_term_goal ?? ""),
            short_term_period: "",
            services: Array.isArray(ab.services) ? (ab.services as Record<string, unknown>[]).map((sv) => ({
              content: String(sv.content ?? ""),
              insurance_flag: "○",
              type: String(sv.type ?? ""),
              provider: String(sv.provider ?? ""),
              frequency: String(sv.frequency ?? ""),
              period: "",
            })) : [],
          }],
        }));
        set("blocks", newBlocks);
        if (result.data?.overall_policy) {
          // 第1表の総合的援助方針も更新可能
        }
        // 使用ログをDBに保存
        await supabaseForAi.from("kaigo_ai_usage_logs").insert({
          user_id: userId || null,
          user_name: userName,
          action: "care-plan-generate",
          mode: aiMode,
          input_tokens: result.usage?.input_tokens ?? 0,
          output_tokens: result.usage?.output_tokens ?? 0,
          estimated_cost: result.usage?.estimated_cost_yen ?? 0,
        });
        const costStr = result.usage?.estimated_cost_yen ? `約${result.usage.estimated_cost_yen}円` : "";
        toast.success(`AIがケアプランを生成しました（入力:${result.usage?.input_tokens} 出力:${result.usage?.output_tokens}トークン ${costStr}）`);
      }
    } catch (e) {
      toast.error("AI生成に失敗しました: " + (e instanceof Error ? e.message : ""));
    } finally {
      setAiGenerating(false);
    }
  };

  // 旧形式の互換: blocks配列がなければ旧データから変換
  const rawBlocksEdit = Array.isArray(content.needs_blocks) ? content.needs_blocks : Array.isArray(content.blocks) ? content.blocks : null;
  const blocks: NeedsBlock[] = rawBlocksEdit ? (rawBlocksEdit as NeedsBlock[]) : [{
    needs: s("needs"),
    long_term_goal: s("long_term_goal"),
    long_term_period: s("long_term_period"),
    goals: [{
      short_term_goal: s("short_term_goal"),
      short_term_period: s("short_term_period"),
      services: Array.isArray(content.services) ? (content.services as NeedsBlock["goals"][0]["services"]) : [],
    }],
  }];

  const updateBlocks = (newBlocks: NeedsBlock[]) => set("needs_blocks", newBlocks);
  const updateBlock = (bi: number, key: keyof NeedsBlock, v: string) => {
    const nb = blocks.map((b, i) => i === bi ? { ...b, [key]: v } : b);
    updateBlocks(nb);
  };
  const addBlock = () => updateBlocks([...blocks, {
    needs: "", long_term_goal: "", long_term_period: "",
    goals: [{ short_term_goal: "", short_term_period: "", services: [{ content: "", insurance_flag: "○", type: "", provider: "", frequency: "", period: "" }] }],
  }]);
  const removeBlock = (bi: number) => updateBlocks(blocks.filter((_, i) => i !== bi));

  const updateGoal = (bi: number, gi: number, key: string, v: string) => {
    const nb = blocks.map((b, i) => i !== bi ? b : {
      ...b, goals: b.goals.map((g, j) => j !== gi ? g : { ...g, [key]: v }),
    });
    updateBlocks(nb);
  };
  const addGoal = (bi: number) => {
    const nb = blocks.map((b, i) => i !== bi ? b : {
      ...b, goals: [...b.goals, { short_term_goal: "", short_term_period: "", services: [{ content: "", insurance_flag: "○", type: "", provider: "", frequency: "", period: "" }] }],
    });
    updateBlocks(nb);
  };
  const removeGoal = (bi: number, gi: number) => {
    const nb = blocks.map((b, i) => i !== bi ? b : { ...b, goals: b.goals.filter((_, j) => j !== gi) });
    updateBlocks(nb);
  };

  const updateSvc = (bi: number, gi: number, si: number, key: string, v: string) => {
    const nb = blocks.map((b, i) => i !== bi ? b : {
      ...b, goals: b.goals.map((g, j) => j !== gi ? g : {
        ...g, services: g.services.map((sv, k) => k !== si ? sv : { ...sv, [key]: v }),
      }),
    });
    updateBlocks(nb);
  };
  const addSvc = (bi: number, gi: number) => {
    const nb = blocks.map((b, i) => i !== bi ? b : {
      ...b, goals: b.goals.map((g, j) => j !== gi ? g : {
        ...g, services: [...g.services, { content: "", insurance_flag: "○", type: "", provider: "", frequency: "", period: "" }],
      }),
    });
    updateBlocks(nb);
  };
  const removeSvc = (bi: number, gi: number, si: number) => {
    const nb = blocks.map((b, i) => i !== bi ? b : {
      ...b, goals: b.goals.map((g, j) => j !== gi ? g : {
        ...g, services: g.services.filter((_, k) => k !== si),
      }),
    });
    updateBlocks(nb);
  };

  return (
    <div className="p-4 space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <FI label="利用者名" value={s("user_name")} onChange={(v) => set("user_name", v)} />
        <FI label="計画作成日" value={s("creation_date")} onChange={(v) => set("creation_date", v)} />
      </div>

      {/* AI生成パネル */}
      {aiEnabled && (
        <div className="rounded-lg border-2 border-purple-200 bg-purple-50/50 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-purple-700">🤖 AIケアプラン生成</span>
              <span className="text-[10px] text-purple-500">Claude Sonnet</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <select
              value={aiMode}
              onChange={(e) => setAiMode(e.target.value as "from-services" | "from-services-grouped" | "full")}
              className="rounded-lg border px-3 py-1.5 text-sm bg-white focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
            >
              <option value="from-services">①サービスから逆引き（種類別に分ける）</option>
              <option value="from-services-grouped">②サービスから逆引き（できるだけまとめる）</option>
              <option value="full">③利用者情報から全体提案</option>
            </select>
            <button
              onClick={handleAiGenerate}
              disabled={aiGenerating}
              className="flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50 transition-colors"
            >
              {aiGenerating ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  生成中...
                </>
              ) : (
                <>AIで生成</>
              )}
            </button>
          </div>
          <p className="mt-2 text-[10px] text-purple-500">
            {aiMode === "from-services"
              ? "①サービスごとに個別のニーズ・目標を生成（詳細なプラン向き）"
              : aiMode === "from-services-grouped"
              ? "②関連するサービスを1つのニーズにまとめて生成（シンプルなプラン向き）"
              : "③利用者のアセスメント情報からケアプラン全体を提案"}
          </p>
        </div>
      )}

      {blocks.map((block, bi) => (
        <div key={bi} className="rounded-lg border-2 border-blue-200 bg-blue-50/30 p-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold text-blue-700">ニーズ {bi + 1}</span>
            {blocks.length > 1 && <button onClick={() => removeBlock(bi)} className="text-xs text-red-400 hover:text-red-600">削除</button>}
          </div>
          <FI label="生活全般の解決すべき課題（ニーズ）" value={block.needs} onChange={(v) => updateBlock(bi, "needs", v)} textarea rows={2} />
          <div className="grid grid-cols-2 gap-2">
            <FI label="長期目標" value={block.long_term_goal} onChange={(v) => updateBlock(bi, "long_term_goal", v)} textarea rows={2} />
            <FI label="長期目標（期間）" value={block.long_term_period} onChange={(v) => updateBlock(bi, "long_term_period", v)} />
          </div>

          {block.goals.map((goal, gi) => (
            <div key={gi} className="ml-4 rounded border border-green-200 bg-green-50/30 p-2 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-green-700">短期目標 {gi + 1}</span>
                {block.goals.length > 1 && <button onClick={() => removeGoal(bi, gi)} className="text-xs text-red-400 hover:text-red-600">削除</button>}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <FI label="短期目標" value={goal.short_term_goal} onChange={(v) => updateGoal(bi, gi, "short_term_goal", v)} textarea rows={2} />
                <FI label="短期目標（期間）" value={goal.short_term_period} onChange={(v) => updateGoal(bi, gi, "short_term_period", v)} />
              </div>

              {goal.services.map((svc, si) => (
                <div key={si} className="ml-4 grid grid-cols-7 gap-1 rounded border border-gray-200 bg-white p-1.5 relative">
                  {goal.services.length > 1 && <button onClick={() => removeSvc(bi, gi, si)} className="absolute right-1 top-0.5 text-gray-300 hover:text-red-400"><X size={10} /></button>}
                  <FI label="サービス内容" value={svc.content} onChange={(v) => updateSvc(bi, gi, si, "content", v)} className="col-span-2" />
                  <FI label="※1" value={svc.insurance_flag} onChange={(v) => updateSvc(bi, gi, si, "insurance_flag", v)} />
                  <ProviderTypeSelector
                    type={svc.type}
                    provider={svc.provider}
                    onTypeChange={(v) => updateSvc(bi, gi, si, "type", v)}
                    onProviderChange={(v) => updateSvc(bi, gi, si, "provider", v)}
                  />
                  <FI label="頻度" value={svc.frequency} onChange={(v) => updateSvc(bi, gi, si, "frequency", v)} />
                  <FI label="期間" value={svc.period} onChange={(v) => updateSvc(bi, gi, si, "period", v)} />
                </div>
              ))}
              <button onClick={() => addSvc(bi, gi)} className="text-xs text-blue-500 hover:text-blue-700">＋ サービス追加</button>
            </div>
          ))}
          <button onClick={() => addGoal(bi)} className="text-xs text-green-600 hover:text-green-800">＋ 短期目標追加</button>
        </div>
      ))}
      <button onClick={addBlock} className="flex items-center gap-1 rounded bg-blue-100 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-200">
        <Plus size={12} /> ニーズを追加
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CarePlan3 (第3表) edit form
// ---------------------------------------------------------------------------

function EditFormCarePlan3({ content, onChange }: {
  content: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
}) {
  const s = (k: string) => String(content[k] ?? "");
  const set = (k: string, v: unknown) => onChange({ ...content, [k]: v });
  const schedule: Schedule = (content.schedule as Schedule) ?? emptySchedule();

  const setCell = (rowKey: string, day: string, v: string) => {
    const updated = { ...schedule, [rowKey]: { ...(schedule[rowKey] ?? {}), [day]: v } };
    set("schedule", updated);
  };

  return (
    <div className="p-4 space-y-3">
      <div className="grid grid-cols-4 gap-3">
        <FI label="利用者名" value={s("user_name")} onChange={(v) => set("user_name", v)} className="col-span-2" />
        <FI label="作成日" value={s("creation_date")} onChange={(v) => set("creation_date", v)} />
      </div>
      <div>
        <div className="text-xs font-semibold text-gray-600 mb-2">週間スケジュール（第3表）</div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th className="border border-gray-300 bg-gray-100 px-1 py-1 text-center w-10" colSpan={2}>時間</th>
                {WEEK_DAY_JA.map((d, i) => (
                  <th
                    key={i}
                    className={`border border-gray-300 bg-gray-100 px-1 py-1 text-center ${i === 5 ? "text-blue-600" : ""} ${i === 6 ? "text-red-600" : ""}`}
                  >
                    {d}
                  </th>
                ))}
                <th className="border border-gray-300 bg-gray-100 px-1 py-1 text-center w-36">主な日常生活上の活動</th>
              </tr>
            </thead>
            <tbody>
              {CARE_PLAN3_TIME_ROWS.map((row, ri) => (
                <tr key={row.key}>
                  {row.periodSpan && (
                    <td
                      rowSpan={row.periodSpan}
                      className="border border-gray-300 bg-red-50 text-red-600 text-center font-medium px-1 py-1 w-6 align-middle"
                      style={{ writingMode: "vertical-rl", letterSpacing: "0.1em" }}
                    >
                      {row.period}
                    </td>
                  )}
                  <td className="border border-gray-300 bg-gray-50 text-right text-[11px] text-gray-600 px-1 py-0.5 w-12 align-top tabular-nums relative">
                    {row.time}
                    {ri === CARE_PLAN3_TIME_ROWS.length - 1 && (
                      <span className="absolute bottom-0.5 right-1 text-[11px] text-gray-600">24:00</span>
                    )}
                  </td>
                  {WEEK_DAYS.map((d, di) => (
                    <td
                      key={d}
                      className={`border border-gray-300 p-0 ${di === 5 ? "bg-blue-50/30" : ""} ${di === 6 ? "bg-red-50/30" : ""}`}
                    >
                      <textarea
                        rows={2}
                        value={getSchedCell(schedule, row.key, d)}
                        onChange={(e) => setCell(row.key, d, e.target.value)}
                        className="w-full resize-none text-[11px] leading-tight p-1 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-transparent min-w-[70px]"
                      />
                    </td>
                  ))}
                  {ri === 0 && (
                    <td
                      rowSpan={CARE_PLAN3_TIME_ROWS.length}
                      className="border border-gray-300 p-0 align-top"
                    >
                      <textarea
                        value={s("daily_activities")}
                        onChange={(e) => set("daily_activities", e.target.value)}
                        className="w-full h-full min-h-[280px] resize-none text-[11px] leading-snug p-2 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-transparent"
                        placeholder="起床・食事・入浴等の日常生活上の活動"
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <FI label="週単位以外のサービス" value={s("other_services")} onChange={(v) => set("other_services", v)} textarea rows={3} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ServiceUsage / ServiceProvision edit form (shared)
// ---------------------------------------------------------------------------


function EditFormServiceTicket({ content, onChange }: {
  content: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
}) {
  const s = (k: string) => String(content[k] ?? "");
  const set = (k: string, v: unknown) => onChange({ ...content, [k]: v });
  const supabase = createClient();

  // サービス選択モーダル
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [selectorTarget, setSelectorTarget] = useState<number | null>(null);

  // 時間帯選択モーダル
  const [timeModalOpen, setTimeModalOpen] = useState(false);
  const [timeModalTarget, setTimeModalTarget] = useState<number | null>(null);

  // 事業所マスタ
  const [providers, setProviders] = useState<{ provider_number: string; provider_name: string }[]>([]);

  useEffect(() => {
    const fetchProviders = async () => {
      const { data: provs } = await supabase.from("kaigo_service_providers").select("provider_number, provider_name").eq("status", "active").order("provider_name");
      setProviders(provs || []);
    };
    fetchProviders();
  }, [supabase]);

  const services: SvcRow[] = Array.isArray(content.services)
    ? (content.services as SvcRow[]).map((r) => ({
        ...emptyServiceRow(), ...r,
        planned: Array.isArray(r.planned) ? [...r.planned, ...Array(31).fill(false)].slice(0, 31) : Array(31).fill(false),
        actual:  Array.isArray(r.actual)  ? [...r.actual,  ...Array(31).fill(false)].slice(0, 31) : Array(31).fill(false),
      }))
    : [];

  const addSvc = () => onChange({ ...content, services: [...services, emptyServiceRow()] });
  const removeSvc = (i: number) => onChange({ ...content, services: services.filter((_, idx) => idx !== i) });
  const updateSvc = (i: number, k: keyof SvcRow, v: unknown) =>
    onChange({ ...content, services: services.map((r, idx) => idx === i ? { ...r, [k]: v } : r) });
  const toggleDay = (svcIdx: number, field: "planned" | "actual", dayIdx: number) => {
    const arr = [...services[svcIdx][field]];
    arr[dayIdx] = !arr[dayIdx];
    updateSvc(svcIdx, field, arr);
  };
  const fillAll = (svcIdx: number, field: "planned" | "actual") => {
    updateSvc(svcIdx, field, Array(31).fill(true));
  };
  const clearAll = (svcIdx: number, field: "planned" | "actual") => {
    updateSvc(svcIdx, field, Array(31).fill(false));
  };
  const fillWeekdays = (svcIdx: number, field: "planned" | "actual") => {
    // 対象月の曜日を計算して平日のみ
    const [y, m] = (String(content.report_month ?? selectedYearMonth ?? format(new Date(), "yyyy-MM"))).split("-").map(Number);
    const arr = Array(31).fill(false);
    for (let d = 1; d <= 31; d++) {
      const date = new Date(y, m - 1, d);
      if (date.getMonth() !== m - 1) break; // 月を超えた
      const dow = date.getDay();
      if (dow !== 0 && dow !== 6) arr[d - 1] = true;
    }
    updateSvc(svcIdx, field, arr);
  };
  const selectedYearMonth = String(content.report_month ?? format(new Date(), "yyyy-MM"));

  const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

  return (
    <div className="p-4 space-y-3">
      <div className="grid grid-cols-4 gap-3">
        <FI label="保険者番号" value={s("insurer_number")} onChange={(v) => set("insurer_number", v)} />
        <FI label="被保険者番号" value={s("insured_number")} onChange={(v) => set("insured_number", v)} />
        <FI label="保険者名" value={s("insurer_name")} onChange={(v) => set("insurer_name", v)} />
        <FI label="利用者氏名" value={s("user_name")} onChange={(v) => set("user_name", v)} />
      </div>
      <div className="grid grid-cols-4 gap-3">
        <FI label="要介護度" value={s("care_level")} onChange={(v) => set("care_level", v)} />
        <FI label="区分支給限度基準額" value={s("limit_amount")} onChange={(v) => set("limit_amount", v)} />
        <FI label="限度額適用期間" value={s("limit_period")} onChange={(v) => set("limit_period", v)} />
        <FI label="作成年月日" value={s("creation_date")} onChange={(v) => set("creation_date", v)} />
      </div>
      <FI label="届出年月日" value={s("submission_date")} onChange={(v) => set("submission_date", v)} />

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-600">サービス一覧（最大9件）</span>
          {services.length < 9 && (
            <button onClick={addSvc} className="flex items-center gap-1 rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-100">
              <Plus size={12} /> サービス追加
            </button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="border-collapse text-[10px] w-full" style={{ minWidth: 900 }}>
            <thead>
              <tr className="bg-gray-100">
                <th className="border border-gray-300 px-1 py-0.5 whitespace-nowrap">時間帯</th>
                <th className="border border-gray-300 px-1 py-0.5 whitespace-nowrap">サービス内容</th>
                <th className="border border-gray-300 px-1 py-0.5 whitespace-nowrap">事業所</th>
                <th className="border border-gray-300 px-1 py-0.5 w-6"></th>
                {DAYS.map((d) => (
                  <th key={d} className="border border-gray-300 px-0 py-0.5 w-5 text-center leading-none">{d}</th>
                ))}
                <th className="border border-gray-300 px-1 py-0.5 whitespace-nowrap">計</th>
                <th className="border border-gray-300 px-0 py-0.5 w-5"></th>
              </tr>
            </thead>
            <tbody>
              {services.length === 0 && (
                <tr>
                  <td colSpan={37} className="border border-dashed border-gray-200 py-3 text-center text-gray-400">
                    サービスを追加してください（最大9件）
                  </td>
                </tr>
              )}
              {services.map((svc, i) => {
                const plannedCount = svc.planned.filter(Boolean).length;
                const actualCount  = svc.actual.filter(Boolean).length;
                return (
                  <>
                    {/* 予定 row */}
                    <tr key={`${i}-planned`} style={{ height: 18 }}>
                      <td rowSpan={2} className="border border-gray-300 px-0.5 align-middle">
                        <button
                          onClick={() => { setTimeModalTarget(i); setTimeModalOpen(true); }}
                          className="w-full text-left text-[10px] px-1 py-0.5 rounded hover:bg-blue-50 transition-colors truncate"
                          title="クリックして時間帯を選択"
                        >
                          {svc.time || <span className="text-gray-400">選択...</span>}
                        </button>
                      </td>
                      <td rowSpan={2} className="border border-gray-300 px-0.5 align-middle">
                        <button
                          onClick={() => { setSelectorTarget(i); setSelectorOpen(true); }}
                          className="w-full text-left text-[10px] px-1 py-0.5 rounded hover:bg-blue-50 transition-colors truncate"
                          title={svc.content || "クリックしてサービスを選択"}
                        >
                          {svc.content || <span className="text-gray-400">選択...</span>}
                        </button>
                      </td>
                      <td rowSpan={2} className="border border-gray-300 px-0.5 align-middle">
                        <select
                          className="w-full text-[10px] bg-transparent outline-none border-0 cursor-pointer"
                          value={svc.provider}
                          onChange={(e) => updateSvc(i, "provider", e.target.value)}
                        >
                          <option value="">-- 選択 --</option>
                          {providers.map((p) => (
                            <option key={p.provider_number} value={p.provider_name}>
                              {p.provider_name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="border border-dashed border-gray-300 px-0.5 text-center whitespace-nowrap">
                        <div className="flex items-center gap-0.5 justify-center">
                          <span className="text-gray-500 text-[10px]">予定</span>
                          <button onClick={() => fillAll(i, "planned")} title="全日" className="text-[8px] text-blue-500 hover:text-blue-700 px-0.5 rounded hover:bg-blue-50">全</button>
                          <button onClick={() => fillWeekdays(i, "planned")} title="平日" className="text-[8px] text-blue-500 hover:text-blue-700 px-0.5 rounded hover:bg-blue-50">平</button>
                          <button onClick={() => clearAll(i, "planned")} title="クリア" className="text-[8px] text-red-400 hover:text-red-600 px-0.5 rounded hover:bg-red-50">消</button>
                        </div>
                      </td>
                      {DAYS.map((_, di) => (
                        <td
                          key={di}
                          onClick={() => toggleDay(i, "planned", di)}
                          className="border border-dashed border-gray-300 text-center cursor-pointer select-none hover:bg-blue-50"
                          style={{ height: 18, width: 18, minWidth: 18 }}
                        >
                          {svc.planned[di] ? <span className="text-blue-600 font-semibold">1</span> : null}
                        </td>
                      ))}
                      <td className="border border-dashed border-gray-300 text-center text-blue-700 font-semibold">{plannedCount || ""}</td>
                      <td rowSpan={2} className="border border-gray-300 text-center align-middle">
                        <button onClick={() => removeSvc(i)} className="text-gray-300 hover:text-red-400"><X size={10} /></button>
                      </td>
                    </tr>
                    {/* 実績 row */}
                    <tr key={`${i}-actual`} style={{ height: 18 }}>
                      <td className="border border-gray-300 px-0.5 text-center whitespace-nowrap">
                        <div className="flex items-center gap-0.5 justify-center">
                          <span className="text-gray-500 text-[10px]">実績</span>
                          <button onClick={() => fillAll(i, "actual")} title="全日" className="text-[8px] text-green-600 hover:text-green-800 px-0.5 rounded hover:bg-green-50">全</button>
                          <button onClick={() => fillWeekdays(i, "actual")} title="平日" className="text-[8px] text-green-600 hover:text-green-800 px-0.5 rounded hover:bg-green-50">平</button>
                          <button onClick={() => clearAll(i, "actual")} title="クリア" className="text-[8px] text-red-400 hover:text-red-600 px-0.5 rounded hover:bg-red-50">消</button>
                        </div>
                      </td>
                      {DAYS.map((_, di) => (
                        <td
                          key={di}
                          onClick={() => toggleDay(i, "actual", di)}
                          className="border border-gray-300 text-center cursor-pointer select-none hover:bg-green-50"
                          style={{ height: 18, width: 18, minWidth: 18 }}
                        >
                          {svc.actual[di] ? <span className="text-green-700 font-semibold">1</span> : null}
                        </td>
                      ))}
                      <td className="border border-gray-300 text-center text-green-700 font-semibold">{actualCount || ""}</td>
                    </tr>
                  </>
                );
              })}
              {/* 合計行 */}
              {services.length > 0 && (
                <>
                  <tr style={{ height: 18 }}>
                    <td colSpan={4} className="border border-gray-300 bg-gray-100 px-1 text-center text-[10px] font-semibold text-blue-700">予定合計</td>
                    {DAYS.map((_, di) => {
                      const count = services.filter((svc) => svc.planned[di]).length;
                      return (
                        <td key={di} className="border border-dashed border-gray-300 text-center text-[10px] text-blue-700 font-semibold bg-blue-50" style={{ width: 18, minWidth: 18 }}>
                          {count > 0 ? count : ""}
                        </td>
                      );
                    })}
                    <td className="border border-gray-300 text-center text-[10px] text-blue-700 font-semibold bg-blue-50">
                      {services.reduce((sum, svc) => sum + svc.planned.filter(Boolean).length, 0) || ""}
                    </td>
                    <td className="border border-gray-300" />
                  </tr>
                  <tr style={{ height: 18 }}>
                    <td colSpan={4} className="border border-gray-300 bg-gray-100 px-1 text-center text-[10px] font-semibold text-green-700">実績合計</td>
                    {DAYS.map((_, di) => {
                      const count = services.filter((svc) => svc.actual[di]).length;
                      return (
                        <td key={di} className="border border-gray-300 text-center text-[10px] text-green-700 font-semibold bg-green-50" style={{ width: 18, minWidth: 18 }}>
                          {count > 0 ? count : ""}
                        </td>
                      );
                    })}
                    <td className="border border-gray-300 text-center text-[10px] text-green-700 font-semibold bg-green-50">
                      {services.reduce((sum, svc) => sum + svc.actual.filter(Boolean).length, 0) || ""}
                    </td>
                    <td className="border border-gray-300" />
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* サービス選択モーダル */}
      <ServiceSelector
        open={selectorOpen}
        onClose={() => { setSelectorOpen(false); setSelectorTarget(null); }}
        onSelect={(svc) => {
          if (selectorTarget !== null) {
            updateSvc(selectorTarget, "content", svc.name);
          }
          setSelectorOpen(false);
          setSelectorTarget(null);
        }}
      />

      {/* 提供時間帯モーダル（開始時刻・終了時刻を直接入力） */}
      {timeModalOpen && (
        <TimeRangeModal
          initial={timeModalTarget !== null ? (services[timeModalTarget]?.time ?? "") : ""}
          onCancel={() => { setTimeModalOpen(false); setTimeModalTarget(null); }}
          onSubmit={(value) => {
            if (timeModalTarget !== null) updateSvc(timeModalTarget, "time", value);
            setTimeModalOpen(false);
            setTimeModalTarget(null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 時間帯入力モーダル（開始〜終了を直接入力）
// ---------------------------------------------------------------------------
function TimeRangeModal({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const parseInitial = (raw: string): { start: string; end: string } => {
    const m = raw.match(/^(\d{1,2}):?(\d{2})?\s*[〜~\-]\s*(\d{1,2}):?(\d{2})?$/);
    if (m) {
      const sh = m[1].padStart(2, "0");
      const sm = (m[2] ?? "00").padStart(2, "0");
      const eh = m[3].padStart(2, "0");
      const em = (m[4] ?? "00").padStart(2, "0");
      return { start: `${sh}:${sm}`, end: `${eh}:${em}` };
    }
    return { start: "", end: "" };
  };
  const parsed = parseInitial(initial);
  const [start, setStart] = useState(parsed.start || "09:00");
  const [end, setEnd] = useState(parsed.end || "10:00");

  const handleOk = () => {
    if (!start || !end) return;
    onSubmit(`${start}〜${end}`);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-80"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-sm font-bold text-gray-800">提供時間帯</h3>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600">
            <X size={16} />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">開始時刻</label>
              <input
                type="time"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="w-full rounded-md border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">終了時刻</label>
              <input
                type="time"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="w-full rounded-md border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>
          <div className="text-xs text-gray-500 text-center">
            プレビュー: <span className="font-semibold text-gray-800">{start}〜{end}</span>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t px-4 py-3">
          <button
            onClick={onCancel}
            className="rounded-md border border-gray-300 bg-white px-4 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            キャンセル
          </button>
          <button
            onClick={handleOk}
            className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invoice edit form
// ---------------------------------------------------------------------------

function EditFormInvoice({ content, onChange }: {
  content: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
}) {
  const s = (k: string) => String(content[k] ?? "");
  const n = (k: string) => Number(content[k] ?? 0);
  const set = (k: string, v: unknown) => onChange({ ...content, [k]: v });
  const items: InvoiceItem[] = Array.isArray(content.items) ? (content.items as InvoiceItem[]) : [];

  const addItem = () => set("items", [...items, { content: "", units: 0, unit_price: 0, amount: 0 }]);
  const removeItem = (i: number) => set("items", items.filter((_, idx) => idx !== i));
  const updateItem = (i: number, k: keyof InvoiceItem, v: string | number) => {
    const updated = items.map((row, idx) => {
      if (idx !== i) return row;
      const next = { ...row, [k]: v };
      if (k === "units" || k === "unit_price") next.amount = Number(next.units) * Number(next.unit_price);
      return next;
    });
    const total = updated.reduce((sum, r) => sum + r.amount, 0);
    onChange({ ...content, items: updated, total });
  };

  return (
    <div className="p-4 space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <FI label="利用者名" value={s("user_name")} onChange={(v) => set("user_name", v)} />
        <FI label="請求月" value={s("billing_month")} onChange={(v) => set("billing_month", v)} />
        <FI label="事業所名" value={s("office_name")} onChange={(v) => set("office_name", v)} />
      </div>
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-600">明細</span>
          <button onClick={addItem} className="flex items-center gap-1 rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-100">
            <Plus size={12} /> 行を追加
          </button>
        </div>
        <div className="space-y-2">
          {items.map((row, i) => (
            <div key={i} className="relative grid grid-cols-5 gap-2 rounded border border-gray-200 bg-gray-50 p-2">
              <button onClick={() => removeItem(i)} className="absolute right-1 top-1 text-gray-300 hover:text-red-400"><X size={12} /></button>
              <FI label="サービス内容" value={row.content} onChange={(v) => updateItem(i, "content", v)} className="col-span-2" />
              <FI label="単位数" value={String(row.units)} onChange={(v) => updateItem(i, "units", Number(v) || 0)} />
              <FI label="単価" value={String(row.unit_price)} onChange={(v) => updateItem(i, "unit_price", Number(v) || 0)} />
              <FI label="金額" value={String(row.amount)} onChange={() => {}} />
            </div>
          ))}
          {items.length === 0 && (
            <div className="rounded border-2 border-dashed border-gray-200 py-3 text-center text-xs text-gray-400">明細を追加してください</div>
          )}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3 rounded border bg-gray-50 p-3">
        <FI label="合計金額" value={String(n("total"))} onChange={(v) => set("total", Number(v) || 0)} />
        <FI label="保険給付額" value={String(n("insurance_amount"))} onChange={(v) => set("insurance_amount", Number(v) || 0)} />
        <FI label="自己負担額" value={String(n("copay_amount"))} onChange={(v) => set("copay_amount", Number(v) || 0)} />
      </div>
      <FI label="備考" value={s("notes")} onChange={(v) => set("notes", v)} textarea rows={3} />
    </div>
  );
}

// 第7表 専用編集フォーム
type UsageDetailItem = {
  provider_name: string; provider_number: string; service_content: string; service_code: string;
  units: number; discount_units: number; count: number; service_units: number;
  over_type_units: number; over_limit_units: number; within_limit_units: number;
  unit_price: number; total_cost: number; benefit_rate: number; insurance_claim: number;
  fixed_copay: number; user_copay: number; user_full_pay: number;
};

function EditFormUsageDetail({ content, onChange }: {
  content: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
}) {
  const s = (k: string) => String(content[k] ?? "");
  const set = (k: string, v: unknown) => onChange({ ...content, [k]: v });
  const items: UsageDetailItem[] = Array.isArray(content.items) ? (content.items as UsageDetailItem[]) : [];
  const shortStay = (content.short_stay_days as { prev: number; current: number; total: number }) ?? { prev: 0, current: 0, total: 0 };

  const updateItem = (i: number, k: keyof UsageDetailItem, v: number | string) => {
    const updated = items.map((item, idx) => {
      if (idx !== i) return item;
      const next = { ...item, [k]: v };
      // 自動計算
      next.discount_units = next.units;
      next.service_units = next.units;
      next.total_cost = Math.round(next.within_limit_units * next.unit_price);
      next.insurance_claim = Math.round(next.total_cost * next.benefit_rate / 100);
      next.user_copay = next.total_cost - next.insurance_claim;
      return next;
    });
    onChange({ ...content, items: updated });
  };
  const addItem = () => onChange({ ...content, items: [...items, {
    provider_name: "", provider_number: "", service_content: "", service_code: "",
    units: 0, discount_units: 0, count: 0, service_units: 0,
    over_type_units: 0, over_limit_units: 0, within_limit_units: 0,
    unit_price: 10.00, total_cost: 0, benefit_rate: 90, insurance_claim: 0,
    fixed_copay: 0, user_copay: 0, user_full_pay: 0,
  }]});
  const removeItem = (i: number) => onChange({ ...content, items: items.filter((_, idx) => idx !== i) });

  const totalUnits = items.reduce((sum, it) => sum + it.within_limit_units, 0);
  const totalCost = items.reduce((sum, it) => sum + it.total_cost, 0);
  const totalInsurance = items.reduce((sum, it) => sum + it.insurance_claim, 0);
  const totalCopay = items.reduce((sum, it) => sum + it.user_copay, 0);

  return (
    <div className="p-4 space-y-4">
      <div className="grid grid-cols-4 gap-3">
        <FI label="利用者名" value={s("user_name")} onChange={(v) => set("user_name", v)} />
        <FI label="要介護度" value={s("care_level")} onChange={(v) => set("care_level", v)} />
        <FI label="区分支給限度基準額" value={s("limit_amount")} onChange={(v) => set("limit_amount", v)} />
        <FI label="作成年月日" value={s("creation_date")} onChange={(v) => set("creation_date", v)} />
      </div>

      {/* サマリー */}
      <div className="grid grid-cols-4 gap-3 rounded bg-blue-50 p-3">
        <div className="text-xs"><span className="text-gray-500">限度額内合計:</span> <b>{totalUnits.toLocaleString()}</b> 単位</div>
        <div className="text-xs"><span className="text-gray-500">費用総額:</span> <b>{totalCost.toLocaleString()}</b> 円</div>
        <div className="text-xs"><span className="text-gray-500">保険請求額:</span> <b>{totalInsurance.toLocaleString()}</b> 円</div>
        <div className="text-xs"><span className="text-gray-500">利用者負担:</span> <b>{totalCopay.toLocaleString()}</b> 円</div>
      </div>

      {/* 明細テーブル */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-600">区分支給限度管理・利用者負担計算</span>
          <button onClick={addItem} className="flex items-center gap-1 rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-100">
            <Plus size={12} /> 行追加
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="text-[10px] border-collapse w-full">
            <thead>
              <tr className="bg-gray-100">
                <th className="border border-gray-300 px-1 py-0.5">事業所名</th>
                <th className="border border-gray-300 px-1 py-0.5">事業所番号</th>
                <th className="border border-gray-300 px-1 py-0.5">サービス内容</th>
                <th className="border border-gray-300 px-1 py-0.5">単位数</th>
                <th className="border border-gray-300 px-1 py-0.5">回数</th>
                <th className="border border-gray-300 px-1 py-0.5">限度額内</th>
                <th className="border border-gray-300 px-1 py-0.5">超過</th>
                <th className="border border-gray-300 px-1 py-0.5">単価</th>
                <th className="border border-gray-300 px-1 py-0.5">費用総額</th>
                <th className="border border-gray-300 px-1 py-0.5">給付率%</th>
                <th className="border border-gray-300 px-1 py-0.5">保険請求</th>
                <th className="border border-gray-300 px-1 py-0.5">利用者負担</th>
                <th className="border border-gray-300 px-1 py-0.5 w-6"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={i}>
                  <td className="border border-gray-300 px-1"><input className="w-full text-[10px] bg-transparent outline-none" value={item.provider_name} onChange={(e) => updateItem(i, "provider_name", e.target.value)} /></td>
                  <td className="border border-gray-300 px-1"><input className="w-full text-[10px] bg-transparent outline-none" value={item.provider_number} onChange={(e) => updateItem(i, "provider_number", e.target.value)} /></td>
                  <td className="border border-gray-300 px-1"><input className="w-full text-[10px] bg-transparent outline-none" value={item.service_content} onChange={(e) => updateItem(i, "service_content", e.target.value)} /></td>
                  <td className="border border-gray-300 px-1 text-right"><input className="w-12 text-[10px] bg-transparent outline-none text-right" type="number" value={item.units} onChange={(e) => updateItem(i, "units", Number(e.target.value))} /></td>
                  <td className="border border-gray-300 px-1 text-right"><input className="w-8 text-[10px] bg-transparent outline-none text-right" type="number" value={item.count} onChange={(e) => updateItem(i, "count", Number(e.target.value))} /></td>
                  <td className="border border-gray-300 px-1 text-right"><input className="w-12 text-[10px] bg-transparent outline-none text-right" type="number" value={item.within_limit_units} onChange={(e) => updateItem(i, "within_limit_units", Number(e.target.value))} /></td>
                  <td className="border border-gray-300 px-1 text-right">{item.over_limit_units}</td>
                  <td className="border border-gray-300 px-1 text-right">{item.unit_price}</td>
                  <td className="border border-gray-300 px-1 text-right font-semibold">{item.total_cost.toLocaleString()}</td>
                  <td className="border border-gray-300 px-1 text-right">{item.benefit_rate}</td>
                  <td className="border border-gray-300 px-1 text-right text-blue-700">{item.insurance_claim.toLocaleString()}</td>
                  <td className="border border-gray-300 px-1 text-right">{item.user_copay.toLocaleString()}</td>
                  <td className="border border-gray-300 px-1 text-center"><button onClick={() => removeItem(i)} className="text-gray-300 hover:text-red-400"><X size={10} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 短期入所利用日数 */}
      <div className="grid grid-cols-3 gap-3">
        <FI label="前月までの利用日数" value={String(shortStay.prev)} onChange={(v) => set("short_stay_days", { ...shortStay, prev: Number(v) })} />
        <FI label="今月の計画利用日数" value={String(shortStay.current)} onChange={(v) => set("short_stay_days", { ...shortStay, current: Number(v) })} />
        <FI label="累積利用日数" value={String(shortStay.prev + shortStay.current)} onChange={() => {}} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SupportProgress (第5表) edit form
// ---------------------------------------------------------------------------

type SupportEntry = { date: string; category: string; content: string };

function EditFormSupportProgress({ content, onChange }: {
  content: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
}) {
  const s = (k: string) => String(content[k] ?? "");
  const set = (k: string, v: unknown) => onChange({ ...content, [k]: v });
  const entries: SupportEntry[] = Array.isArray(content.entries) ? (content.entries as SupportEntry[]) : [];

  const addEntry = () => set("entries", [...entries, { date: "", category: "", content: "" }]);
  const removeEntry = (i: number) => set("entries", entries.filter((_, idx) => idx !== i));
  const updateEntry = (i: number, k: keyof SupportEntry, v: string) =>
    set("entries", entries.map((r, idx) => idx === i ? { ...r, [k]: v } : r));

  return (
    <div className="p-4 space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <FI label="利用者名" value={s("user_name")} onChange={(v) => set("user_name", v)} />
        <FI label="作成年月日" value={s("creation_date")} onChange={(v) => set("creation_date", v)} />
        <FI label="居宅サービス計画作成者氏名" value={s("creator_name")} onChange={(v) => set("creator_name", v)} />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-600">経過記録</span>
          <button onClick={addEntry} className="flex items-center gap-1 rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-100">
            <Plus size={12} /> 追加
          </button>
        </div>
        <div className="space-y-2">
          {entries.map((entry, i) => (
            <div key={i} className="relative grid grid-cols-7 gap-2 rounded border border-gray-200 bg-gray-50 p-2">
              <button onClick={() => removeEntry(i)} className="absolute right-1 top-1 text-gray-300 hover:text-red-400">
                <X size={12} />
              </button>
              <FI label="年月日" value={entry.date} onChange={(v) => updateEntry(i, "date", v)} />
              <FI label="項目" value={entry.category} onChange={(v) => updateEntry(i, "category", v)} />
              <FI label="内容" value={entry.content} onChange={(v) => updateEntry(i, "content", v)} className="col-span-5" />
            </div>
          ))}
          {entries.length === 0 && (
            <div className="rounded border-2 border-dashed border-gray-200 py-3 text-center text-xs text-gray-400">
              経過記録を追加してください
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EditFormGeneric({ content, onChange, label = "内容（JSON編集）" }: {
  content: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
  label?: string;
}) {
  const [raw, setRaw] = useState(JSON.stringify(content, null, 2));
  const [err, setErr] = useState<string | null>(null);
  const handle = (v: string) => {
    setRaw(v);
    try { onChange(JSON.parse(v)); setErr(null); } catch { setErr("JSON形式が正しくありません"); }
  };
  return (
    <div className="p-4 space-y-2">
      <label className="text-xs font-medium text-gray-500">{label}</label>
      <textarea rows={18} value={raw} onChange={(e) => handle(e.target.value)}
        className={`w-full rounded border px-2 py-1 font-mono text-xs focus:outline-none ${err ? "border-red-400" : "border-gray-300"}`} />
      {err && <p className="text-xs text-red-500">{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Print views per report type
// ---------------------------------------------------------------------------

function PrintCarePlan1({ c }: { c: Record<string, unknown> }) {
  const s = (k: string) => String(c[k] ?? "");
  const B = "1px solid #000";
  const cellBase: React.CSSProperties = { border: B, padding: "2px 4px", fontSize: "8.5pt", verticalAlign: "middle" };
  const thStyle: React.CSSProperties = { ...cellBase, backgroundColor: "#f0f0f0", fontWeight: "bold", textAlign: "left" };
  const tdStyle: React.CSSProperties = { ...cellBase, backgroundColor: "#fff" };
  const lineStyle: React.CSSProperties = { borderBottom: "1px dotted #999", height: "18px", width: "100%" };

  return (
    <div style={{ fontFamily: '"MS Mincho","游明朝","Hiragino Mincho ProN",serif', fontSize: "9pt", color: "#000", position: "relative", width: "277mm", height: "190mm", overflow: "hidden" }}>
      {/* 第1表ラベル */}
      <div style={{ border: B, display: "inline-block", padding: "1px 8px", fontSize: "8pt", marginBottom: "4px" }}>第１表</div>

      {/* タイトル行 */}
      <div style={{ textAlign: "center", marginBottom: "2px" }}>
        <span style={{ fontSize: "14pt", fontWeight: "bold", letterSpacing: "0.3em" }}>居宅サービス計画書（１）</span>
        <span style={{ float: "right", fontSize: "8.5pt" }}>
          作成年月日　　　年　　月　　日
        </span>
      </div>

      {/* 初回・紹介・継続 / 認定済・申請中 */}
      <div style={{ textAlign: "right", marginBottom: "4px", fontSize: "8.5pt" }}>
        <span style={{ border: B, padding: "1px 6px", marginRight: "8px" }}>
          {["初回","紹介","継続"].map((t, i) => <span key={t}>{i > 0 ? "　・　" : ""}{s("plan_type") === t ? <b>{t}</b> : t}</span>)}
        </span>
        <span style={{ border: B, padding: "1px 6px" }}>
          {["認定済","申請中"].map((t, i) => <span key={t}>{i > 0 ? "　・　" : ""}{s("cert_status") === t ? <b>{t}</b> : t}</span>)}
        </span>
      </div>

      {/* ヘッダー情報テーブル */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "4px" }}>
        <tbody>
          {/* 利用者名 / 生年月日 / 住所 */}
          <tr>
            <td style={{ ...tdStyle, width: "12%", fontWeight: "bold" }}>利用者名</td>
            <td style={{ ...tdStyle, width: "22%", fontWeight: "bold", fontSize: "11pt" }}>{s("user_name")}　殿</td>
            <td style={{ ...tdStyle, width: "8%" }}>生年月日</td>
            <td style={{ ...tdStyle, width: "14%" }}>{s("birth_date") ? fmtReiwa(s("birth_date")) : "　年　月　日"}</td>
            <td style={{ ...tdStyle, width: "5%" }}>住所</td>
            <td style={{ ...tdStyle, width: "39%" }}>{s("address")}</td>
          </tr>
          {/* 居宅サービス計画作成者氏名 */}
          <tr>
            <td colSpan={2} style={{ ...tdStyle, fontSize: "8pt" }}>居宅サービス計画作成者氏名</td>
            <td colSpan={4} style={tdStyle}>{s("creator_name")}</td>
          </tr>
          {/* 居宅介護支援事業者 */}
          <tr>
            <td colSpan={2} style={{ ...tdStyle, fontSize: "8pt" }}>居宅介護支援事業者・事業所名及び所在地</td>
            <td colSpan={4} style={tdStyle}>{s("office_name")}</td>
          </tr>
          {/* 計画作成日 / 初回作成日 */}
          <tr>
            <td colSpan={2} style={{ ...tdStyle, fontSize: "8pt" }}>居宅サービス計画作成（変更）日</td>
            <td style={tdStyle}>{s("creation_date")}</td>
            <td colSpan={2} style={{ ...tdStyle, fontSize: "8pt" }}>初回居宅サービス計画作成日</td>
            <td style={tdStyle}>{s("initial_creation_date")}</td>
          </tr>
          {/* 認定日 / 認定の有効期間 */}
          <tr>
            <td style={{ ...tdStyle, fontSize: "8pt" }}>認定日</td>
            <td style={tdStyle}></td>
            <td style={{ ...tdStyle, fontSize: "8pt" }}>認定の有効期間</td>
            <td colSpan={3} style={tdStyle}>{s("cert_period")}</td>
          </tr>
        </tbody>
      </table>

      {/* 要介護状態区分 */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "8px" }}>
        <tbody>
          <tr>
            <td style={{ ...thStyle, width: "15%" }}>要介護状態区分</td>
            <td style={{ ...tdStyle, fontSize: "9pt", letterSpacing: "0.1em" }}>
              {["要介護１","要介護２","要介護３","要介護４","要介護５"].map((lv, i) => {
                const match = s("care_level").replace(/\d/, (d: string) => "１２３４５"["12345".indexOf(d)] || d);
                return <span key={lv}>{i > 0 ? "　・　" : ""}{match === lv ? <b style={{ textDecoration: "underline" }}>{lv}</b> : lv}</span>;
              })}
            </td>
          </tr>
        </tbody>
      </table>

      {/* 利用者及び家族の意向を踏まえた課題分析の結果 */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "6px" }}>
        <tbody>
          <tr>
            <td style={{ ...thStyle, width: "18%", verticalAlign: "middle", height: "140px", lineHeight: "1.8", textAlign: "center", padding: "6px 4px" }}>
              利用者及び家族の<br />生活に対する<br />意向<span style={{ color: "red" }}>を踏まえた</span><br /><span style={{ color: "red" }}>課題分析の結果</span>
            </td>
            <td style={{ ...tdStyle, verticalAlign: "top", whiteSpace: "pre-wrap", padding: "6px 8px", position: "relative" }}>
              {s("issue_analysis")}
              <div style={{ position: "absolute", top: "4px", left: "8px", right: "8px", bottom: "4px", pointerEvents: "none", display: "flex", flexDirection: "column", justifyContent: "space-evenly" }}>
                {Array.from({ length: 7 }).map((_, i) => <div key={i} style={lineStyle} />)}
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      {/* 介護認定審査会の意見及びサービスの種類の指定 */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "6px" }}>
        <tbody>
          <tr>
            <td style={{ ...thStyle, width: "18%", verticalAlign: "middle", height: "70px", lineHeight: "1.8", textAlign: "center", padding: "6px 4px" }}>
              介護認定審査会の<br />意見及びサービス<br />の種類の指定
            </td>
            <td style={{ ...tdStyle, verticalAlign: "top", whiteSpace: "pre-wrap", padding: "6px 8px", position: "relative" }}>
              {s("review_opinion")}
              <div style={{ position: "absolute", top: "4px", left: "8px", right: "8px", bottom: "4px", pointerEvents: "none", display: "flex", flexDirection: "column", justifyContent: "space-evenly" }}>
                {Array.from({ length: 3 }).map((_, i) => <div key={i} style={lineStyle} />)}
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      {/* 総合的な援助の方針 */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "6px" }}>
        <tbody>
          <tr>
            <td style={{ ...thStyle, width: "18%", verticalAlign: "middle", height: "160px", lineHeight: "1.8", textAlign: "center", padding: "6px 4px" }}>
              <br />総合的な援助の<br />方　　　　針
            </td>
            <td style={{ ...tdStyle, verticalAlign: "top", whiteSpace: "pre-wrap", padding: "6px 8px", position: "relative" }}>
              {s("overall_policy")}
              <div style={{ position: "absolute", top: "4px", left: "8px", right: "8px", bottom: "4px", pointerEvents: "none", display: "flex", flexDirection: "column", justifyContent: "space-evenly" }}>
                {Array.from({ length: 9 }).map((_, i) => <div key={i} style={lineStyle} />)}
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      {/* 生活援助中心型の算定理由 */}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          <tr>
            <td style={{ ...thStyle, width: "18%", height: "36px", textAlign: "center", padding: "4px" }}>生活援助中心型の<br />算　定　理　由</td>
            <td style={{ ...tdStyle, fontSize: "9pt", padding: "6px 8px" }}>
              {s("living_support_reason") || "１．一人暮らし　　２．家族等が障害、疾病等　　３．その他（　　　　　　　　　　　）"}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function PrintCarePlan2({ c }: { c: Record<string, unknown> }) {
  const s = (k: string) => String(c[k] ?? "");
  const B = "1px solid #000";
  const cellBase: React.CSSProperties = { border: B, padding: "2px 4px", fontSize: "8pt", verticalAlign: "top" };
  const thStyle: React.CSSProperties = { ...cellBase, backgroundColor: "#f0f0f0", fontWeight: "bold", textAlign: "center" };
  const tdStyle: React.CSSProperties = { ...cellBase, backgroundColor: "#fff", whiteSpace: "pre-wrap" };

  // blocksデータ構造から行を展開（needs_blocks / blocks の両方に対応）
  const rawBlocks = Array.isArray(c.needs_blocks) ? c.needs_blocks : Array.isArray(c.blocks) ? c.blocks : null;
  const blocks: NeedsBlock[] = rawBlocks ? (rawBlocks as NeedsBlock[]) : [{
    needs: s("needs"), long_term_goal: s("long_term_goal"), long_term_period: s("long_term_period"),
    goals: [{ short_term_goal: s("short_term_goal"), short_term_period: s("short_term_period"),
      services: Array.isArray(c.services) ? (c.services as NeedsBlock["goals"][0]["services"]) : [] }],
  }];

  // 全行をフラット化（ニーズ→目標→サービスの階層をrowspanで表現）
  type FlatRow = {
    needsSpan?: number; needs?: string;
    ltGoalSpan?: number; ltGoal?: string; ltPeriod?: string;
    stGoalSpan?: number; stGoal?: string; stPeriod?: string;
    content: string; flag: string; type: string; provider: string; freq: string; period: string;
  };
  const flatRows: FlatRow[] = [];
  for (const block of blocks) {
    let needsRowCount = 0;
    const goalRows: FlatRow[][] = [];
    for (const goal of block.goals) {
      const svcs = goal.services.length > 0 ? goal.services : [{ content: "", insurance_flag: "", type: "", provider: "", frequency: "", period: "" }];
      const gRows: FlatRow[] = svcs.map((sv, si) => ({
        ...(si === 0 ? { stGoalSpan: svcs.length, stGoal: goal.short_term_goal, stPeriod: goal.short_term_period } : {}),
        content: sv.content, flag: sv.insurance_flag, type: sv.type, provider: sv.provider, freq: sv.frequency, period: sv.period,
      }));
      needsRowCount += gRows.length;
      goalRows.push(gRows);
    }
    // 最初の行にニーズと長期目標のrowspanを付与
    let first = true;
    let ltFirst = true;
    for (const gRows of goalRows) {
      for (const row of gRows) {
        if (first) { row.needsSpan = needsRowCount; row.needs = block.needs; row.ltGoalSpan = needsRowCount; row.ltGoal = block.long_term_goal; row.ltPeriod = block.long_term_period; first = false; ltFirst = false; }
        else if (ltFirst) { ltFirst = false; }
        flatRows.push(row);
      }
    }
  }
  // 最低8行に（空行は全セル出力）
  const dataRowCount = flatRows.length;
  const MIN_ROWS = 8;
  if (dataRowCount < MIN_ROWS) {
    const emptyCount = MIN_ROWS - dataRowCount;
    for (let ei = 0; ei < emptyCount; ei++) {
      flatRows.push({
        needsSpan: ei === 0 ? emptyCount : undefined,
        needs: ei === 0 ? "" : undefined,
        ltGoalSpan: ei === 0 ? emptyCount : undefined,
        ltGoal: ei === 0 ? "" : undefined,
        ltPeriod: ei === 0 ? "" : undefined,
        stGoalSpan: ei === 0 ? emptyCount : undefined,
        stGoal: ei === 0 ? "" : undefined,
        stPeriod: ei === 0 ? "" : undefined,
        content: "", flag: "", type: "", provider: "", freq: "", period: "",
      });
    }
  }

  // A4横に固定（297mm×210mm、余白10mm）→ 277mm×190mm
  // ヘッダー部分 ≒ 55px、脚注+署名 ≒ 55px、残り = テーブル本体
  // 1行の高さを均等に割り当て
  const TOTAL_ROWS = flatRows.length;
  const tableBodyHeight = 440; // px（A4横の本体部分に相当）
  const rowHeight = Math.max(28, Math.floor(tableBodyHeight / TOTAL_ROWS));

  return (
    <div style={{ fontFamily: '"MS Mincho","游明朝","Hiragino Mincho ProN",serif', fontSize: "9pt", color: "#000", width: "277mm", height: "190mm", position: "relative", overflow: "hidden" }}>
      {/* ヘッダー: 第2表ラベル / タイトル / 作成年月日 */}
      <div style={{ position: "relative", marginBottom: "4px" }}>
        <div style={{ border: B, display: "inline-block", padding: "1px 8px", fontSize: "8pt" }}>第２表</div>
        <div style={{ position: "absolute", left: 0, right: 0, top: 0, textAlign: "center", fontSize: "14pt", fontWeight: "bold", letterSpacing: "0.3em" }}>
          居宅サービス計画書（２）
        </div>
        <div style={{ position: "absolute", right: 0, top: "2px", fontSize: "8pt" }}>
          作成年月日　{s("creation_date") || "　　年　　月　　日"}
        </div>
      </div>
      {/* 利用者名 */}
      <div style={{ fontSize: "9pt", marginBottom: "4px" }}>
        <span style={{ fontWeight: "bold" }}>利用者名　{s("user_name")}　殿</span>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ ...thStyle, width: "13%" }} rowSpan={2}>生活全般の解決す<br />べき課題（ニーズ）</th>
            <th colSpan={4} style={thStyle}>目　　　　標</th>
            <th colSpan={6} style={thStyle}>援　助　内　容</th>
          </tr>
          <tr>
            <th style={{ ...thStyle, width: "10%" }}>長期目標</th>
            <th style={{ ...thStyle, width: "6%" }}>（期間）</th>
            <th style={{ ...thStyle, width: "10%" }}>短期目標</th>
            <th style={{ ...thStyle, width: "6%" }}>（期間）</th>
            <th style={{ ...thStyle, width: "15%" }}>サービス内容</th>
            <th style={{ ...thStyle, width: "3%", fontSize: "7pt" }}>※1</th>
            <th style={{ ...thStyle, width: "10%" }}>サービス種別</th>
            <th style={{ ...thStyle, width: "5%", fontSize: "7pt" }}>※2</th>
            <th style={{ ...thStyle, width: "5%" }}>頻度</th>
            <th style={{ ...thStyle, width: "6%" }}>期間</th>
          </tr>
        </thead>
        <tbody>
          {flatRows.map((row, i) => (
            <tr key={i} style={{ height: `${rowHeight}px` }}>
              {row.needsSpan !== undefined && <td rowSpan={row.needsSpan} style={{ ...tdStyle, padding: "4px" }}>{row.needs || "　"}</td>}
              {row.ltGoalSpan !== undefined && <td rowSpan={row.ltGoalSpan} style={{ ...tdStyle, padding: "4px" }}>{row.ltGoal || "　"}</td>}
              {row.ltGoalSpan !== undefined && <td rowSpan={row.ltGoalSpan} style={{ ...tdStyle, fontSize: "7pt", padding: "3px" }}>{row.ltPeriod || "　"}</td>}
              {row.stGoalSpan !== undefined && <td rowSpan={row.stGoalSpan} style={{ ...tdStyle, padding: "4px" }}>{row.stGoal || "　"}</td>}
              {row.stGoalSpan !== undefined && <td rowSpan={row.stGoalSpan} style={{ ...tdStyle, fontSize: "7pt", padding: "3px" }}>{row.stPeriod || "　"}</td>}
              <td style={{ ...tdStyle, padding: "3px 4px" }}>{row.content || "　"}</td>
              <td style={{ ...tdStyle, textAlign: "center" }}>{row.flag || "　"}</td>
              <td style={{ ...tdStyle, padding: "3px 4px" }}>{row.type || "　"}</td>
              <td style={{ ...tdStyle, fontSize: "7pt", padding: "3px" }}>{row.provider || "　"}</td>
              <td style={{ ...tdStyle, textAlign: "center" }}>{row.freq || "　"}</td>
              <td style={{ ...tdStyle, fontSize: "7pt", padding: "3px" }}>{row.period || "　"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: "6px", fontSize: "7.5pt", lineHeight: "1.6" }}>
        ※1「保険給付の対象となるかどうかの区分」について、保険給付対象内サービスについては○印を付す。<br />
        ※2「当該サービス提供を行う事業所」について記入する。
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Print: CarePlan3 (第3表)
// ---------------------------------------------------------------------------

function PrintCarePlan3({ c }: { c: Record<string, unknown> }) {
  const s = (k: string) => String(c[k] ?? "　");
  const B = "1px solid #000";
  const cellBase: React.CSSProperties = { border: B, padding: "2px 4px", fontSize: "8.5pt", verticalAlign: "middle" };
  const thStyle: React.CSSProperties = { ...cellBase, backgroundColor: "#f0f0f0", fontWeight: "bold", textAlign: "center" };
  const tdStyle: React.CSSProperties = { ...cellBase, backgroundColor: "#fff" };
  const lineStyle: React.CSSProperties = { borderBottom: "1px dotted #999", height: "18px", width: "100%" };
  const schedule: Schedule = (c.schedule as Schedule) ?? emptySchedule();

  return (
    <div style={{ fontFamily: '"MS Mincho","游明朝","Hiragino Mincho ProN",serif', fontSize: "9pt", color: "#000", width: "277mm", height: "190mm", overflow: "hidden" }}>
      {/* ヘッダー: 第3表 / タイトル / 作成年月日 */}
      <div style={{ position: "relative", marginBottom: "4px" }}>
        <div style={{ border: B, display: "inline-block", padding: "1px 8px", fontSize: "8pt" }}>第３表</div>
        <div style={{ position: "absolute", left: 0, right: 0, top: 0, textAlign: "center", fontSize: "14pt", fontWeight: "bold", letterSpacing: "0.3em" }}>
          週間サービス計画表
        </div>
        <div style={{ position: "absolute", right: 0, top: "2px", fontSize: "8pt" }}>
          作成年月日　{s("creation_date")}
        </div>
      </div>
      <div style={{ fontSize: "9pt", marginBottom: "4px" }}>
        <span style={{ fontWeight: "bold" }}>利用者名　{s("user_name")}　殿</span>
      </div>

      {/* メイングリッド */}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <colgroup>
          <col style={{ width: "3%" }} />
          <col style={{ width: "5%" }} />
          {WEEK_DAY_JA.map((_, i) => (
            <col key={i} style={{ width: "11.3%" }} />
          ))}
          <col style={{ width: "13%" }} />
        </colgroup>
        <thead>
          <tr style={{ height: "22px" }}>
            <th style={thStyle} colSpan={2}></th>
            {WEEK_DAY_JA.map((d, i) => (
              <th key={i} style={thStyle}>{d}</th>
            ))}
            <th style={thStyle}>主な日常生活上の活動</th>
          </tr>
        </thead>
        <tbody>
          {CARE_PLAN3_TIME_ROWS.map((row, ri) => (
            <tr key={row.key} style={{ height: ri === CARE_PLAN3_TIME_ROWS.length - 1 ? "36px" : "30px" }}>
              {row.periodSpan && (
                <td
                  rowSpan={row.periodSpan}
                  style={{
                    ...thStyle,
                    fontSize: "8pt",
                    color: "#c00",
                    fontWeight: "normal",
                    writingMode: "vertical-rl",
                    letterSpacing: "0.2em",
                    padding: "2px 0",
                    backgroundColor: "#fff",
                  }}
                >
                  {row.period}
                </td>
              )}
              <td style={{ ...thStyle, fontSize: "8pt", textAlign: "right", padding: "2px 4px", backgroundColor: "#fff", fontWeight: "normal", verticalAlign: "top", position: "relative" }}>
                {row.time}
                {ri === CARE_PLAN3_TIME_ROWS.length - 1 && (
                  <span style={{ position: "absolute", bottom: "2px", right: "4px", fontSize: "8pt" }}>24:00</span>
                )}
              </td>
              {WEEK_DAYS.map((d) => (
                <td
                  key={d}
                  style={{ ...tdStyle, verticalAlign: "top", whiteSpace: "pre-wrap", fontSize: "7pt", padding: "2px 3px", position: "relative" }}
                >
                  {getSchedCell(schedule, row.key, d)}
                  <div style={{ position: "absolute", top: 0, left: "3px", right: "3px", bottom: 0, pointerEvents: "none", display: "flex", flexDirection: "column", justifyContent: "space-evenly" }}>
                    <div style={lineStyle} />
                  </div>
                </td>
              ))}
              {ri === 0 && (
                <td
                  rowSpan={CARE_PLAN3_TIME_ROWS.length}
                  style={{ ...tdStyle, verticalAlign: "top", whiteSpace: "pre-wrap", fontSize: "7pt", padding: "4px", position: "relative" }}
                >
                  {s("daily_activities")}
                  <div style={{ position: "absolute", top: "4px", left: "4px", right: "4px", bottom: "4px", pointerEvents: "none", display: "flex", flexDirection: "column", justifyContent: "space-evenly" }}>
                    {Array.from({ length: 12 }).map((_, i) => <div key={i} style={lineStyle} />)}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {/* 週単位以外のサービス */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "6px" }}>
        <tbody>
          <tr>
            <td style={{ ...thStyle, width: "8%", textAlign: "left", padding: "4px", fontSize: "8pt" }}>週単位以外<br />のサービス</td>
            <td style={{ ...tdStyle, height: "40px", verticalAlign: "top", whiteSpace: "pre-wrap", padding: "4px 6px", position: "relative" }}>
              {s("other_services")}
              <div style={{ position: "absolute", top: "4px", left: "6px", right: "6px", bottom: "4px", pointerEvents: "none", display: "flex", flexDirection: "column", justifyContent: "space-evenly" }}>
                {Array.from({ length: 2 }).map((_, i) => <div key={i} style={lineStyle} />)}
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Print: ServiceUsage / ServiceProvision (shared layout)
// ---------------------------------------------------------------------------

function PrintServiceTicket({ c, title }: { c: Record<string, unknown>; title: string }) {
  const s = (k: string) => String(c[k] ?? "　");
  const B = "1px solid #000";
  const cellBase: React.CSSProperties = { border: B, padding: "1px 3px", fontSize: "7pt", verticalAlign: "middle" };
  const thStyle: React.CSSProperties = { ...cellBase, backgroundColor: "#f0f0f0", fontWeight: "bold", textAlign: "center" };
  const tdStyle: React.CSSProperties = { ...cellBase, backgroundColor: "#fff" };
  const tdGreen: React.CSSProperties = { ...tdStyle, backgroundColor: "#e8f5e9" };
  const thGreen: React.CSSProperties = { ...thStyle, backgroundColor: "#c8e6c9" };

  const tableNum = "第６表";

  const services: SvcRow[] = Array.isArray(c.services)
    ? (c.services as SvcRow[]).map((r) => ({
        ...emptyServiceRow(), ...r,
        planned: Array.isArray(r.planned) ? [...r.planned, ...Array(31).fill(false)].slice(0, 31) : Array(31).fill(false),
        actual:  Array.isArray(r.actual)  ? [...r.actual,  ...Array(31).fill(false)].slice(0, 31) : Array(31).fill(false),
      }))
    : [];
  const rows = Array.from({ length: 9 }, (_, i) => services[i] ?? emptyServiceRow());
  const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);
  // Weekday names for the header row (simplified cyclic: 月火水木金土日 repeating from day 1)
  const WDAY_JA = ["月","火","水","木","金","土","日"];

  return (
    <div style={{ fontFamily: '"MS Mincho","游明朝","Hiragino Mincho ProN",serif', fontSize: "7pt", color: "#000", width: "277mm", height: "190mm", overflow: "hidden" }}>
      {/* 表番号ラベル */}
      <div style={{ border: B, display: "inline-block", padding: "1px 8px", fontSize: "7pt", marginBottom: "3px" }}>{tableNum}</div>

      {/* タイトル */}
      <div style={{ textAlign: "center", marginBottom: "3px" }}>
        <span style={{ fontSize: "13pt", fontWeight: "bold", letterSpacing: "0.3em" }}>{title}</span>
      </div>

      {/* ヘッダー情報（公式書式3行） */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "3px" }}>
        <tbody>
          {/* 1行目: 保険者番号 / 保険者名 / 居宅介護支援事業者名 / 作成年月日 / 利用者確認 */}
          <tr style={{ height: "28px" }}>
            <td style={{ ...thStyle, width: "8%" }}>保険者<br />番号</td>
            <td style={{ ...tdStyle, width: "10%" }}>{s("insurer_number")}</td>
            <td style={{ ...thStyle, width: "8%" }}>保険者名</td>
            <td style={{ ...tdStyle, width: "14%" }}>{s("insurer_name")}</td>
            <td style={{ ...thStyle, width: "12%", fontSize: "6pt" }}>居宅介護支援<br />事業者事業所名<br />担当者名</td>
            <td style={{ ...tdStyle, width: "16%" }}></td>
            <td style={{ ...thStyle, width: "7%" }}>作成<br />年月日</td>
            <td style={{ ...tdStyle, width: "10%" }}>{s("creation_date")}</td>
            <td style={{ ...thStyle, width: "7%" }}>利用者確認</td>
            <td style={{ ...tdStyle, width: "8%" }}></td>
          </tr>
          {/* 2行目: 被保険者番号 / 被保険者氏名 / 届出年月日 */}
          <tr style={{ height: "28px" }}>
            <td style={thStyle}>被保険者<br />番号</td>
            <td style={tdStyle}>{s("insured_number")}</td>
            <td style={{ ...thStyle, fontSize: "6pt" }}>フリガナ<br /><span style={{ fontSize: "7pt" }}>被保険者氏名</span></td>
            <td style={{ ...tdStyle, fontWeight: "bold" }}>{s("user_name")}</td>
            <td style={tdStyle} colSpan={2}></td>
            <td style={thStyle}>届出<br />年月日</td>
            <td style={tdStyle} colSpan={3}>{s("submission_date")}</td>
          </tr>
          {/* 3行目: 生年月日 / 性別 / 要介護状態区分 / 区分支給限度基準額 / 限度額適用期間 */}
          <tr style={{ height: "36px" }}>
            <td style={thStyle}>生年月日</td>
            <td style={tdStyle}></td>
            <td style={thStyle}>性別</td>
            <td style={{ ...tdStyle, width: "4%" }}></td>
            <td style={{ ...thStyle, fontSize: "6pt" }}>要介護状態区<br />分<br /><span style={{ fontSize: "5.5pt" }}>変更後<br />要介護状態区分<br />変更日</span></td>
            <td style={tdStyle}>{s("care_level")}</td>
            <td style={{ ...thStyle, fontSize: "6pt" }}>区分支給<br />限度基準額</td>
            <td style={tdStyle}>{s("limit_amount")}<br /><span style={{ fontSize: "6pt" }}>単位/月</span></td>
            <td style={{ ...thStyle, fontSize: "6pt" }}>限度額<br />適用期間</td>
            <td style={{ ...tdStyle, fontSize: "6pt" }}>{s("limit_period")}</td>
          </tr>
        </tbody>
      </table>

      {/* サービス票テーブル — A4横の残り高さを使い切る */}
      {(() => {
        // ヘッダー部≒140px, フッター≒25px, テーブルヘッダー≒35px, タイトル≒30px
        // 残り ≒ 190mm(≒718px) - 230px ≒ 488px → 18行で割る
        const ROW_H = Math.floor(488 / 18); // ≒27px per row
        return (
          <>
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: "3%" }} />
              <col style={{ width: "6%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "10%" }} />
              {DAYS.map((d) => <col key={d} style={{ width: `${71 / 31}%` }} />)}
              <col style={{ width: "3%" }} />
            </colgroup>
            <thead>
              <tr style={{ height: "18px" }}>
                <th style={thStyle} rowSpan={2}>No</th>
                <th style={thStyle} rowSpan={2}>提供<br />時間帯</th>
                <th style={thStyle} rowSpan={2}>サービス内容</th>
                <th style={thStyle} rowSpan={2}>事業所名</th>
                {DAYS.map((d) => {
                  const wdi = (d - 1) % 7;
                  const isWE = wdi === 5 || wdi === 6;
                  return <th key={d} style={isWE ? thGreen : thStyle}>{d}</th>;
                })}
                <th style={thStyle} rowSpan={2}>合計</th>
              </tr>
              <tr style={{ height: "14px" }}>
                {DAYS.map((d) => {
                  const wdi = (d - 1) % 7;
                  const isWE = wdi === 5 || wdi === 6;
                  return <th key={d} style={{ ...(isWE ? thGreen : thStyle), fontSize: "6pt" }}>{WDAY_JA[wdi]}</th>;
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((svc, i) => {
                const plannedCount = svc.planned.filter(Boolean).length;
                const actualCount = svc.actual.filter(Boolean).length;
                return (
                <React.Fragment key={i}>
                  {/* 予定行 */}
                  <tr style={{ height: `${ROW_H}px` }}>
                    <td style={{ ...thStyle, fontSize: "7pt" }} rowSpan={2}>{i + 1}</td>
                    <td style={{ ...tdStyle, verticalAlign: "top", whiteSpace: "pre-wrap", fontSize: "6.5pt" }} rowSpan={2}>{svc.time || "　"}</td>
                    <td style={{ ...tdStyle, verticalAlign: "top", whiteSpace: "pre-wrap", fontSize: "6.5pt" }} rowSpan={2}>{svc.content || "　"}</td>
                    <td style={{ ...tdStyle, verticalAlign: "top", fontSize: "6.5pt" }} rowSpan={2}>{svc.provider || "　"}</td>
                    {svc.planned.map((v, di) => {
                      const wdi = di % 7;
                      const isWE = wdi === 5 || wdi === 6;
                      return <td key={di} style={{ ...(isWE ? tdGreen : tdStyle), textAlign: "center", padding: "0", borderStyle: "dashed", fontWeight: "bold" }}>{v ? "1" : ""}</td>;
                    })}
                    <td style={{ ...tdStyle, textAlign: "center", fontSize: "7pt" }} rowSpan={2}>{(plannedCount || actualCount) ? `${plannedCount}/${actualCount}` : ""}</td>
                  </tr>
                  {/* 実績行 */}
                  <tr style={{ height: `${ROW_H}px` }}>
                    {svc.actual.map((v, di) => {
                      const wdi = di % 7;
                      const isWE = wdi === 5 || wdi === 6;
                      return <td key={di} style={{ ...(isWE ? tdGreen : tdStyle), textAlign: "center", padding: "0", fontWeight: "bold" }}>{v ? "1" : ""}</td>;
                    })}
                  </tr>
                </React.Fragment>
                );
              })}
              {/* 予定合計行 */}
              <tr style={{ height: `${ROW_H}px` }}>
                <td colSpan={4} style={{ ...thStyle, color: "#1565c0", backgroundColor: "#e3f2fd" }}>予定合計</td>
                {DAYS.map((_, di) => {
                  const count = rows.filter((svc) => svc.planned[di]).length;
                  const wdi = di % 7;
                  const isWE = wdi === 5 || wdi === 6;
                  return <td key={di} style={{ ...(isWE ? thGreen : thStyle), color: "#1565c0", backgroundColor: isWE ? "#bbdefb" : "#e3f2fd", fontWeight: "bold", textAlign: "center", padding: "0" }}>{count > 0 ? count : ""}</td>;
                })}
                <td style={{ ...thStyle, color: "#1565c0", backgroundColor: "#e3f2fd" }}>
                  {rows.reduce((sum, svc) => sum + svc.planned.filter(Boolean).length, 0) || ""}
                </td>
              </tr>
              {/* 実績合計行 */}
              <tr style={{ height: `${ROW_H}px` }}>
                <td colSpan={4} style={{ ...thStyle, color: "#1b5e20", backgroundColor: "#e8f5e9" }}>実績合計</td>
                {DAYS.map((_, di) => {
                  const count = rows.filter((svc) => svc.actual[di]).length;
                  const wdi = di % 7;
                  const isWE = wdi === 5 || wdi === 6;
                  return <td key={di} style={{ ...(isWE ? tdGreen : tdStyle), color: "#1b5e20", backgroundColor: isWE ? "#a5d6a7" : "#e8f5e9", fontWeight: "bold", textAlign: "center", padding: "0" }}>{count > 0 ? count : ""}</td>;
                })}
                <td style={{ ...tdStyle, color: "#1b5e20", backgroundColor: "#e8f5e9", fontWeight: "bold", textAlign: "center" }}>
                  {rows.reduce((sum, svc) => sum + svc.actual.filter(Boolean).length, 0) || ""}
                </td>
              </tr>
            </tbody>
          </table>

          {/* 届出年月日 */}
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "2px" }}>
            <tbody>
              <tr style={{ height: "20px" }}>
                <td style={{ ...thStyle, width: "12%" }}>届出年月日</td>
                <td style={{ ...tdStyle, width: "30%" }}>{s("submission_date")}</td>
                <td style={{ ...thStyle, width: "10%" }}>作成者氏名</td>
                <td style={tdStyle} />
              </tr>
            </tbody>
          </table>
          </>
        );
      })()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Print: Invoice
// ---------------------------------------------------------------------------

function PrintInvoice({ c }: { c: Record<string, unknown> }) {
  const s = (k: string) => String(c[k] ?? "　");
  const n = (k: string) => Number(c[k] ?? 0).toLocaleString();
  const B = "1px solid #000";
  const cellBase: React.CSSProperties = { border: B, padding: "2px 6px", fontSize: "9pt", verticalAlign: "middle" };
  const thStyle: React.CSSProperties = { ...cellBase, backgroundColor: "#f0f0f0", fontWeight: "bold", textAlign: "left" };
  const tdStyle: React.CSSProperties = { ...cellBase, backgroundColor: "#fff" };
  const lineStyle: React.CSSProperties = { borderBottom: "1px dotted #999", height: "18px", width: "100%" };

  const items: InvoiceItem[] = Array.isArray(c.items) ? (c.items as InvoiceItem[]) : [];
  const MIN_ROWS = 8;
  const itemRows: InvoiceItem[] = items.length >= MIN_ROWS
    ? items
    : [...items, ...Array(MIN_ROWS - items.length).fill({ content: "", units: 0, unit_price: 0, amount: 0 })];

  const today = format(new Date(), "yyyy年M月d日", { locale: ja });

  return (
    <div style={{ fontFamily: '"MS Mincho","游明朝","Hiragino Mincho ProN",serif', fontSize: "9pt", color: "#000", width: "190mm", height: "277mm", overflow: "hidden" }}>
      {/* 発行日 */}
      <div style={{ textAlign: "right", fontSize: "8.5pt", marginBottom: "4px" }}>{today}</div>

      {/* タイトル */}
      <div style={{ textAlign: "center", marginBottom: "10px" }}>
        <span style={{ fontSize: "16pt", fontWeight: "bold", letterSpacing: "0.4em" }}>請　求　書</span>
      </div>

      {/* 宛先・請求者ブロック */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "8px" }}>
        <tbody>
          <tr style={{ height: "26px" }}>
            <td style={{ ...thStyle, width: "15%" }}>請求先（利用者）</td>
            <td style={{ ...tdStyle, width: "35%", fontWeight: "bold", fontSize: "11pt" }}>{s("user_name")}　殿</td>
            <td style={{ ...thStyle, width: "15%" }}>請求月</td>
            <td style={{ ...tdStyle }}>{s("billing_month")}</td>
          </tr>
          <tr style={{ height: "22px" }}>
            <td style={thStyle}>請求事業所</td>
            <td colSpan={3} style={tdStyle}>{s("office_name")}</td>
          </tr>
        </tbody>
      </table>

      {/* 明細テーブル */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "6px" }}>
        <thead>
          <tr style={{ height: "24px" }}>
            <th style={{ ...thStyle, width: "5%", textAlign: "center" }}>No.</th>
            <th style={{ ...thStyle, width: "50%", textAlign: "center" }}>サービス内容</th>
            <th style={{ ...thStyle, width: "13%", textAlign: "center" }}>単位数</th>
            <th style={{ ...thStyle, width: "13%", textAlign: "center" }}>単価（円）</th>
            <th style={{ ...thStyle, width: "19%", textAlign: "center" }}>金額（円）</th>
          </tr>
        </thead>
        <tbody>
          {itemRows.map((row: InvoiceItem, i) => (
            <tr key={i} style={{ height: "24px" }}>
              <td style={{ ...tdStyle, textAlign: "center", color: "#666" }}>{i + 1}</td>
              <td style={{ ...tdStyle, padding: "2px 8px" }}>{row.content || "　"}</td>
              <td style={{ ...tdStyle, textAlign: "right", padding: "2px 8px" }}>{row.units ? row.units.toLocaleString() : "　"}</td>
              <td style={{ ...tdStyle, textAlign: "right", padding: "2px 8px" }}>{row.unit_price ? row.unit_price.toLocaleString() : "　"}</td>
              <td style={{ ...tdStyle, textAlign: "right", padding: "2px 8px" }}>{row.amount ? row.amount.toLocaleString() : "　"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* 合計欄 */}
      <table style={{ width: "60%", borderCollapse: "collapse", marginLeft: "auto", marginBottom: "8px" }}>
        <tbody>
          <tr style={{ height: "26px" }}>
            <td style={{ ...thStyle, width: "50%", textAlign: "center", backgroundColor: "#e0e0e0" }}>合　計　金　額</td>
            <td style={{ ...tdStyle, textAlign: "right", padding: "2px 10px", fontWeight: "bold", fontSize: "11pt" }}>{n("total")}　円</td>
          </tr>
          <tr style={{ height: "22px" }}>
            <td style={{ ...thStyle, textAlign: "center" }}>うち保険給付額</td>
            <td style={{ ...tdStyle, textAlign: "right", padding: "2px 10px" }}>{n("insurance_amount")}　円</td>
          </tr>
          <tr style={{ height: "22px" }}>
            <td style={{ ...thStyle, textAlign: "center", backgroundColor: "#ffe0b2" }}>ご請求額（自己負担）</td>
            <td style={{ ...tdStyle, textAlign: "right", padding: "2px 10px", fontWeight: "bold" }}>{n("copay_amount")}　円</td>
          </tr>
        </tbody>
      </table>

      {/* 備考 */}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          <tr>
            <td style={{ ...thStyle, width: "12%", verticalAlign: "top" }}>備考</td>
            <td style={{ ...tdStyle, height: "70px", verticalAlign: "top", padding: "4px 8px", whiteSpace: "pre-wrap", position: "relative" }}>
              {s("notes")}
              <div style={{ position: "absolute", top: 0, left: "8px", right: "8px", bottom: 0, pointerEvents: "none" }}>
                {Array.from({ length: 3 }).map((_, li) => <div key={li} style={{ ...lineStyle, position: "absolute", top: `${20 + li * 18}px` }} />)}
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Print: ServiceUsageDetail (第7表)
// ---------------------------------------------------------------------------

function PrintServiceUsageDetail({ c }: { c: Record<string, unknown> }) {
  const B = "1px solid #000";
  const cellBase: React.CSSProperties = { border: B, padding: "1px 3px", fontSize: "7pt", verticalAlign: "middle" };
  const thStyle: React.CSSProperties = { ...cellBase, backgroundColor: "#f0f0f0", fontWeight: "bold", textAlign: "center" };
  const tdStyle: React.CSSProperties = { ...cellBase, backgroundColor: "#fff", textAlign: "center" };

  // Section 1 data
  type DetailItem = {
    office_name: string; office_number: string; service_content: string; service_code: string;
    units: number; discounted_units: number; count: number; service_units: number;
    category_over_units: number; limit_over_units: number; within_limit_units: number;
    unit_price: number; total_cost: number; benefit_rate: number; insurance_claim: number;
    fixed_copay: number; copay_insured: number; copay_full: number;
  };
  const items: DetailItem[] = Array.isArray(c.items) ? (c.items as DetailItem[]) : [];
  const MAIN_ROWS = 8;
  const dataRows = items.length < MAIN_ROWS
    ? [...items, ...Array(MAIN_ROWS - items.length).fill(null)]
    : items;

  // Section 2: 種類別支給限度管理
  type LimitRow = { type_name: string; limit_units: string; total_units: string; over_units: string };
  const limitRows: LimitRow[] = Array.isArray(c.limit_management) ? (c.limit_management as LimitRow[]) : [];
  const LEFT_TYPES = ["訪問介護","訪問入浴介護","訪問看護","訪問リハビリテーション","通所介護","通所リハビリテーション","福祉用具貸与"];
  const RIGHT_TYPES = ["短期入所生活介護","短期入所療養介護","定期巡回随時対応型訪問介護看護","夜間対応型訪問介護","認知症対応型通所介護","小規模多機能型居宅介護"];

  const getLimitRow = (typeName: string): LimitRow => {
    const found = limitRows.find((r) => r.type_name === typeName);
    return found ?? { type_name: typeName, limit_units: "", total_units: "", over_units: "" };
  };

  // Section 3: 短期入所利用日数
  type ShortStayDays = { prev: number; current: number; total: number };
  const ssd: ShortStayDays = (c.short_stay_days as ShortStayDays) ?? { prev: 0, current: 0, total: 0 };

  // メインテーブル8行、A4の上部約55%を使う
  const MAIN_ROWS_COUNT = 8;
  const mainDataRows = items.length < MAIN_ROWS_COUNT
    ? [...items, ...Array(MAIN_ROWS_COUNT - items.length).fill(null)]
    : items;
  // A4横190mm。上部（タイトル+Section1）≒55%、下部（種類別+短期入所）≒45%
  const mainRowH = 28; // 固定高さ

  return (
    <div style={{ fontFamily: '"MS Mincho","游明朝","Hiragino Mincho ProN",serif', fontSize: "7pt", color: "#000", width: "277mm", height: "190mm", overflow: "hidden" }}>
      {/* ヘッダー行 */}
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "3px" }}>
        <div style={{ border: B, display: "inline-block", padding: "1px 8px", fontSize: "7.5pt" }}>第７表</div>
        <span style={{ fontSize: "8pt" }}>作成年月日　　　年　　月　　日</span>
      </div>
      <div style={{ textAlign: "center", marginBottom: "3px" }}>
        <span style={{ fontSize: "13pt", fontWeight: "bold", letterSpacing: "0.3em" }}>サービス利用票別表</span>
      </div>

      {/* Section 1 */}
      <div style={{ fontSize: "7pt", fontWeight: "bold", marginBottom: "2px" }}>区分支給限度管理・利用者負担計算</div>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "2px" }}>
        <thead>
          <tr>
            <th style={{ ...thStyle, width: "7%" }}>事業所名</th>
            <th style={{ ...thStyle, width: "5%" }}>事業所番号</th>
            <th style={{ ...thStyle, width: "7%" }}>サービス内容/<br />種類</th>
            <th style={{ ...thStyle, width: "4%" }}>サービス<br />コード</th>
            <th style={{ ...thStyle, width: "3.5%" }}>単位数</th>
            <th style={{ ...thStyle, width: "3%" }}>割引後<br /><span style={{ fontSize: "5.5pt" }}>単位数</span></th>
            <th style={{ ...thStyle, width: "3%" }}>回数</th>
            <th style={{ ...thStyle, width: "4%" }}>サービス<br />単位/<br />金額</th>
            <th style={{ ...thStyle, width: "5%" }}>種類支給限度<br />基準を超える<br />単位数</th>
            <th style={{ ...thStyle, width: "5%" }}>区分支給限度<br />基準を超える<br />単位数</th>
            <th style={{ ...thStyle, width: "5%" }}>区分支給限度<br />基準内<br />単位数</th>
            <th style={{ ...thStyle, width: "3.5%" }}>単位数<br />単価</th>
            <th style={{ ...thStyle, width: "5.5%" }}>費用総額<br /><span style={{ fontSize: "5.5pt" }}>保険/事業対象</span></th>
            <th style={{ ...thStyle, width: "3.5%" }}>給付率<br />(%)</th>
            <th style={{ ...thStyle, width: "6%" }}>保険/事業費<br /><span style={{ fontSize: "5.5pt" }}>請求額<br />(税額控除額)</span></th>
            <th style={{ ...thStyle, width: "4.5%" }}>定額利用者<br />負担額</th>
            <th style={{ ...thStyle, width: "5.5%" }}>利用者負担<br /><span style={{ fontSize: "5.5pt" }}>保険/事業対象分</span></th>
            <th style={{ ...thStyle, width: "5.5%" }}>利用者負担<br /><span style={{ fontSize: "5.5pt" }}>全額負担分</span></th>
          </tr>
        </thead>
        <tbody>
          {mainDataRows.map((row, i) => (
            <tr key={i} style={{ height: `${mainRowH}px` }}>
              <td style={tdStyle}>{row?.office_name ?? row?.provider_name ?? ""}</td>
              <td style={tdStyle}>{row?.office_number ?? row?.provider_number ?? ""}</td>
              <td style={{ ...tdStyle, textAlign: "left", paddingLeft: "3px", fontSize: "6.5pt" }}>{row?.service_content ?? ""}</td>
              <td style={tdStyle}>{row?.service_code ?? ""}</td>
              <td style={tdStyle}>{row?.units || ""}</td>
              <td style={tdStyle}>{row?.discount_units ?? row?.discounted_units ?? ""}</td>
              <td style={tdStyle}>{row?.count || ""}</td>
              <td style={tdStyle}>{row?.service_units || ""}</td>
              <td style={tdStyle}>{row?.over_type_units ?? row?.category_over_units ?? ""}</td>
              <td style={tdStyle}>{row?.over_limit_units ?? row?.limit_over_units ?? ""}</td>
              <td style={tdStyle}>{row?.within_limit_units || ""}</td>
              <td style={tdStyle}>{row?.unit_price || ""}</td>
              <td style={tdStyle}>{row?.total_cost || ""}</td>
              <td style={tdStyle}>{row?.benefit_rate || ""}</td>
              <td style={tdStyle}>{row?.insurance_claim || ""}</td>
              <td style={tdStyle}>{row?.fixed_copay ?? ""}</td>
              <td style={tdStyle}>{row?.user_copay ?? row?.copay_insured ?? ""}</td>
              <td style={tdStyle}>{row?.user_full_pay ?? row?.copay_full ?? ""}</td>
            </tr>
          ))}
          <tr style={{ height: "18px" }}>
            <td colSpan={4} style={{ ...thStyle, textAlign: "left", paddingLeft: "3px", fontSize: "6.5pt" }}>
              区分支給限度<br />基準額（単位）
            </td>
            <td colSpan={4} style={tdStyle}></td>
            <td style={tdStyle}>合計</td>
            <td style={tdStyle}></td>
            <td style={tdStyle}></td>
            <td style={tdStyle}></td>
            <td style={tdStyle}></td>
            <td style={tdStyle}></td>
            <td style={tdStyle}></td>
            <td style={tdStyle}></td>
            <td style={tdStyle}></td>
            <td style={tdStyle}></td>
          </tr>
        </tbody>
      </table>

      {/* Section 2: 種類別支給限度管理 */}
      <div style={{ fontSize: "7pt", fontWeight: "bold", marginBottom: "2px" }}>種類別支給限度管理</div>
      <div style={{ display: "flex", gap: "4px", marginBottom: "4px" }}>
        {[LEFT_TYPES, RIGHT_TYPES].map((types, ti) => (
          <table key={ti} style={{ flex: 1, borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, width: "35%", fontSize: "6pt" }}>サービス種類</th>
                <th style={{ ...thStyle, width: "20%", fontSize: "6pt" }}>種類支給限度<br />基準額(単位)</th>
                <th style={{ ...thStyle, width: "20%", fontSize: "6pt" }}>合計単位数</th>
                <th style={{ ...thStyle, width: "25%", fontSize: "6pt" }}>種類支給限度基準<br />を超える単位数</th>
              </tr>
            </thead>
            <tbody>
              {types.map((t) => {
                const r = getLimitRow(t);
                return (
                  <tr key={t} style={{ height: "13px" }}>
                    <td style={{ ...tdStyle, textAlign: "left", paddingLeft: "2px", fontSize: "6pt", color: "red" }}>{t}</td>
                    <td style={tdStyle}>{r.limit_units || ""}</td>
                    <td style={tdStyle}>{r.total_units || ""}</td>
                    <td style={tdStyle}>{r.over_units || ""}</td>
                  </tr>
                );
              })}
              {ti === 1 && (
                <tr style={{ height: "13px" }}>
                  <td style={{ ...thStyle, textAlign: "left", paddingLeft: "2px", fontSize: "6pt" }}>合計</td>
                  <td style={tdStyle}></td>
                  <td style={tdStyle}></td>
                  <td style={tdStyle}></td>
                </tr>
              )}
            </tbody>
          </table>
        ))}
      </div>

      {/* Section 3: 短期入所 */}
      <div style={{ fontSize: "7pt", fontWeight: "bold", marginBottom: "2px" }}>要介護認定期間中の短期入所利用日数</div>
      <table style={{ borderCollapse: "collapse", width: "30%" }}>
        <thead>
          <tr>
            <th style={{ ...thStyle, fontSize: "6pt" }}>前月までの利用日数</th>
            <th style={{ ...thStyle, fontSize: "6pt" }}>今月の計画利用日数</th>
            <th style={{ ...thStyle, fontSize: "6pt" }}>累積利用日数</th>
          </tr>
        </thead>
        <tbody>
          <tr style={{ height: "18px" }}>
            <td style={tdStyle}>{ssd.prev || ""}</td>
            <td style={tdStyle}>{ssd.current || ""}</td>
            <td style={tdStyle}>{ssd.total || ssd.prev + ssd.current || ""}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Print: SupportProgress (第5表)
// ---------------------------------------------------------------------------

function PrintSupportProgress({ c }: { c: Record<string, unknown> }) {
  const s = (k: string) => String(c[k] ?? "");
  const B = "1pt solid #000";
  const BD = "0.5pt dashed #999"; // 点線

  const entries: SupportEntry[] = Array.isArray(c.entries) ? (c.entries as SupportEntry[]) : [];

  // 左右に分配
  const MIN_ROWS = 10;
  const splitPoint = Math.ceil(entries.length / 2);
  const dataLeft = entries.slice(0, splitPoint);
  const dataRight = entries.slice(splitPoint);
  while (dataLeft.length < MIN_ROWS) dataLeft.push({ date: "", category: "", content: "" });
  while (dataRight.length < MIN_ROWS) dataRight.push({ date: "", category: "", content: "" });

  const renderHalf = (rows: SupportEntry[]) => {
    // 各行の前の行と日付が同じか判定
    return (
      <div style={{ flex: 1 }}>
        {/* Column header */}
        <div style={{ display: "flex", borderBottom: B, background: "#f0f0f0" }}>
          <div style={{ width: "12%", padding: "1.5mm 1mm", textAlign: "center", fontWeight: "bold", fontSize: "8pt", borderRight: B }}>年</div>
          <div style={{ width: "5%", padding: "1.5mm 0.5mm", textAlign: "center", fontWeight: "bold", fontSize: "8pt", borderRight: B }}>月</div>
          <div style={{ width: "5%", padding: "1.5mm 0.5mm", textAlign: "center", fontWeight: "bold", fontSize: "8pt", borderRight: B }}>日</div>
          <div style={{ flex: 1, padding: "1.5mm 2mm", textAlign: "center", fontWeight: "bold", fontSize: "8pt" }}>内　　容</div>
        </div>
        {/* Rows */}
        {rows.map((entry, i) => {
          const prevDate = i > 0 ? rows[i - 1].date : "";
          const sameDate = entry.date === prevDate && entry.date !== "";
          const borderTop = (i === 0 || !sameDate) ? B : BD;
          const d = entry.date ? new Date(entry.date) : null;

          return (
            <div key={i} style={{ display: "flex", borderTop, minHeight: "14mm" }}>
              <div style={{ width: "12%", padding: "1mm", fontSize: "7.5pt", borderRight: B, display: "flex", alignItems: "flex-start" }}>
                {entry.date && !sameDate ? (d ? `${d.getFullYear()}` : "") : ""}
              </div>
              <div style={{ width: "5%", padding: "1mm 0.5mm", fontSize: "7.5pt", textAlign: "center", borderRight: B }}>
                {entry.date && !sameDate ? (d ? `${d.getMonth() + 1}` : "") : ""}
              </div>
              <div style={{ width: "5%", padding: "1mm 0.5mm", fontSize: "7.5pt", textAlign: "center", borderRight: B }}>
                {entry.date && !sameDate ? (d ? `${d.getDate()}` : "") : ""}
              </div>
              <div style={{ flex: 1, padding: "1mm 2mm", fontSize: "7.5pt", whiteSpace: "pre-wrap", lineHeight: "1.5" }}>
                {entry.content || "\u00A0"}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div style={{ fontFamily: '"MS Mincho","游明朝","Hiragino Mincho ProN",serif', fontSize: "8pt", color: "#000", width: "285mm", minHeight: "198mm", display: "flex", flexDirection: "column" }}>
      {/* タイトル */}
      <div style={{ textAlign: "center", fontSize: "12pt", fontWeight: "bold", letterSpacing: "0.3em", marginBottom: "3mm" }}>
        居宅介護支援経過記録(サービス担当者会議の要点を含む)
      </div>

      {/* ヘッダー情報 */}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "9pt", marginBottom: "2mm", paddingLeft: "2mm", paddingRight: "2mm" }}>
        <span>利用者氏名　<b>{s("user_name") || "＿＿＿＿＿"}</b></span>
        <span>計画作成者氏名　<b>{s("creator_name") || "＿＿＿＿"}</b>　居宅介護支援事業所　<b>{s("office_name") || "＿＿＿＿＿"}</b></span>
      </div>

      {/* メイン2カラム */}
      <div style={{ display: "flex", border: B, flex: 1 }}>
        {renderHalf(dataLeft)}
        <div style={{ width: "0", borderLeft: B }} />
        {renderHalf(dataRight)}
      </div>
    </div>
  );
}

function PrintGeneric({ c, title }: { c: Record<string, unknown>; title: string }) {
  return (
    <div style={{ fontFamily: '"MS Mincho","游明朝","Hiragino Mincho ProN",serif', fontSize: "9pt", color: "#000" }}>
      <div style={{ textAlign: "center", marginBottom: "8px", fontSize: "11pt", fontWeight: "bold" }}>{title}</div>
      <pre style={{ fontSize: "8pt", whiteSpace: "pre-wrap", border: "1px solid #ccc", padding: "8px" }}>
        {JSON.stringify(c, null, 2)}
      </pre>
    </div>
  );
}

function PrintView({ reportType, content, config }: {
  reportType: string; content: Record<string, unknown>; config: ReportConfig;
}) {
  switch (reportType) {
    case "care-plan-1":       return <PrintCarePlan1 c={content} />;
    case "care-plan-2":       return <PrintCarePlan2 c={content} />;
    case "care-plan-3":       return <PrintCarePlan3 c={content} />;
    case "support-progress":  return <PrintSupportProgress c={content} />;
    case "service-usage":        return <PrintServiceTicket c={content} title="サービス利用票・提供票" />;
    case "service-usage-detail": return <PrintServiceUsageDetail c={content} />;
    default: return <PrintGeneric c={content} title={config.titleJa} />;
  }
}

function EditForm({ reportType, content, onChange }: {
  reportType: string; content: Record<string, unknown>; onChange: (c: Record<string, unknown>) => void;
}) {
  switch (reportType) {
    case "care-plan-1":       return <EditFormCarePlan1 content={content} onChange={onChange} />;
    case "care-plan-2":       return <EditFormCarePlan2 content={content} onChange={onChange} />;
    case "care-plan-3":       return <EditFormCarePlan3 content={content} onChange={onChange} />;
    case "support-progress":  return <EditFormSupportProgress content={content} onChange={onChange} />;
    case "service-usage":        return <EditFormServiceTicket content={content} onChange={onChange} />;
    case "service-usage-detail": return <EditFormUsageDetail content={content} onChange={onChange} />;
    default: return <EditFormGeneric content={content} onChange={onChange} label="内容（JSON編集）" />;
  }
}

// ---------------------------------------------------------------------------
// Print CSS
// ---------------------------------------------------------------------------

const PRINT_STYLE_PORTRAIT = `
@media print {
  body * { visibility: hidden !important; }
  #print-area, #print-area * { visibility: visible !important; }
  #print-area { position: fixed !important; inset: 0 !important; width: 210mm !important; min-height: 297mm !important; padding: 8mm 10mm !important; font-size: 9pt !important; color: #000 !important; background: #fff !important; overflow: visible !important; }
  .no-print { display: none !important; }
  table { border-collapse: collapse !important; }
  td, th { border: 1px solid #000 !important; padding: 1px 2px !important; }
  @page { size: A4 portrait; margin: 0; }
}`;

const PRINT_STYLE_LANDSCAPE = `
@media print {
  body * { visibility: hidden !important; }
  #print-area, #print-area * { visibility: visible !important; }
  #print-area { position: fixed !important; inset: 0 !important; width: 297mm !important; min-height: 210mm !important; padding: 6mm 8mm !important; font-size: 8pt !important; color: #000 !important; background: #fff !important; overflow: visible !important; }
  .no-print { display: none !important; }
  table { border-collapse: collapse !important; }
  td, th { border: 1px solid #000 !important; padding: 1px 2px !important; }
  @page { size: A4 landscape; margin: 0; }
}`;

// ---------------------------------------------------------------------------
// Auto-generation: fetch data then create doc
// ---------------------------------------------------------------------------

async function autoGenerateDoc(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  reportType: string,
  reportMonth: string | null,
  config: ReportConfig,
  certificationId?: string | null,
): Promise<ReportDoc | null> {
  // Fetch user
  const { data: user, error: ue } = await supabase
    .from("kaigo_users").select("*").eq("id", userId).single();
  if (ue || !user) throw new Error("利用者データの取得に失敗しました");

  // Fetch cert
  const { data: certArr } = await supabase
    .from("kaigo_care_certifications").select("*").eq("user_id", userId)
    .eq("status", "active").order("start_date", { ascending: false }).limit(1);
  const cert: CareCertification | null = certArr?.[0] ?? null;

  // Fetch plan
  const { data: planArr } = await supabase
    .from("kaigo_care_plans").select("*").eq("user_id", userId)
    .eq("status", "active").order("start_date", { ascending: false }).limit(1);
  let plan: CarePlan | null = planArr?.[0] ?? null;

  // 計画書（第1表/第2表/第3表）を新規作成するときに kaigo_care_plans が無ければ自動作成
  // これによりモニタリング等の他機能から「有効なケアプラン」として認識されるようになる
  const isCarePlanReport = ["care-plan-1", "care-plan-2", "care-plan-3"].includes(reportType);
  if (!plan && isCarePlanReport) {
    const today = format(new Date(), "yyyy-MM-dd");
    const startDate = cert?.start_date ?? today;
    // end_date: cert.end_date があればそれ、無ければ start_date + 1年
    let endDate = cert?.end_date ?? "";
    if (!endDate) {
      const d = new Date(startDate);
      d.setFullYear(d.getFullYear() + 1);
      d.setDate(d.getDate() - 1);
      endDate = format(d, "yyyy-MM-dd");
    }
    const { data: newPlan, error: planErr } = await supabase
      .from("kaigo_care_plans")
      .insert({
        user_id: userId,
        plan_number: "",
        plan_type: "居宅サービス計画",
        start_date: startDate,
        end_date: endDate,
        long_term_goals: "",
        short_term_goals: "",
        status: "active",
      })
      .select()
      .single();
    if (!planErr && newPlan) {
      plan = newPlan as CarePlan;
    }
  }

  // Fetch services
  let services: CarePlanService[] = [];
  if (plan) {
    const { data: svcs } = await supabase
      .from("kaigo_care_plan_services").select("*").eq("care_plan_id", plan.id).order("service_type");
    services = svcs ?? [];
  }

  // 第7表: 給付管理データから自動生成
  if (reportType === "service-usage-detail" && reportMonth) {
    const { data: benefitData } = await supabase
      .from("kaigo_benefit_management")
      .select("*")
      .eq("user_id", userId)
      .eq("billing_month", reportMonth);

    const baseContent = buildDefaultContent(reportType, user as KaigoUser, cert, plan, services, reportMonth);
    const limitAmount = cert?.support_limit_amount ?? 0;

    if (benefitData && benefitData.length > 0) {
      let totalWithinLimit = 0;
      baseContent.items = benefitData.map((b: Record<string, unknown>) => {
        const actualUnits = Number(b.actual_units ?? 0);
        const unitPrice = 10.00;
        const withinLimit = Math.min(actualUnits, limitAmount - totalWithinLimit);
        const overLimit = Math.max(0, actualUnits - withinLimit);
        totalWithinLimit += withinLimit;
        const totalCost = Math.round(withinLimit * unitPrice);
        const benefitRate = 90;
        const insuranceClaim = Math.round(totalCost * benefitRate / 100);
        const userCopay = totalCost - insuranceClaim;
        return {
          provider_name: String(b.provider_name ?? ""),
          provider_number: String(b.provider_number ?? ""),
          service_content: String(b.service_type ?? ""),
          service_code: "",
          units: actualUnits,
          discount_units: actualUnits,
          count: Number(b.planned_units ?? 0) > 0 ? 1 : 0,
          service_units: actualUnits,
          over_type_units: 0,
          over_limit_units: overLimit,
          within_limit_units: withinLimit,
          unit_price: unitPrice,
          total_cost: totalCost,
          benefit_rate: benefitRate,
          insurance_claim: insuranceClaim,
          fixed_copay: 0,
          user_copay: userCopay,
          user_full_pay: 0,
        };
      });

      // 種類別集計
      const typeMap = new Map<string, number>();
      for (const item of baseContent.items as { service_content: string; within_limit_units: number }[]) {
        const t = item.service_content;
        typeMap.set(t, (typeMap.get(t) ?? 0) + item.within_limit_units);
      }
      baseContent.limit_management = Array.from(typeMap.entries()).map(([t, u]) => ({
        service_type: t, limit: 0, total_units: u, over_units: 0,
      }));
    }

    const todayStr = format(new Date(), "yyyy-MM-dd");
    const title = `${config.titleJa}（${fmtJaYear(reportMonth + "-01")}）`;
    const { data: doc, error: ie } = await supabase
      .from("kaigo_report_documents")
      .insert({ user_id: userId, report_type: reportType, title, report_month: reportMonth, care_plan_id: plan?.id ?? null, content: baseContent, status: "draft" })
      .select().single();
    if (ie) throw new Error("帳票の保存に失敗しました: " + ie.message);
    return doc as ReportDoc;
  }

  // 第5表: 居宅介護支援経過 — 支援記録から自動生成
  if (reportType === "support-progress" && reportMonth) {
    const startDate = reportMonth + "-01";
    const endDateObj = new Date(startDate);
    endDateObj.setMonth(endDateObj.getMonth() + 1);
    endDateObj.setDate(0);
    const endDate = format(endDateObj, "yyyy-MM-dd");

    const { data: supportData } = await supabase
      .from("kaigo_support_records")
      .select("*")
      .eq("user_id", userId)
      .gte("record_date", startDate)
      .lte("record_date", endDate)
      .order("record_date", { ascending: true });

    const baseContent = buildDefaultContent(reportType, user as KaigoUser, cert, plan, services, reportMonth);
    if (supportData && supportData.length > 0) {
      baseContent.entries = supportData.map((r: Record<string, unknown>) => ({
        date: String(r.record_date ?? ""),
        category: String(r.category ?? ""),
        content: String(r.content ?? ""),
      }));
    }

    const todayStr = format(new Date(), "yyyy-MM-dd");
    baseContent.creation_date = fmtReiwa(todayStr);
    const title = `${config.titleJa}（${fmtJaYear(reportMonth + "-01")}）`;
    const { data: doc, error: ie } = await supabase
      .from("kaigo_report_documents")
      .insert({ user_id: userId, certification_id: certificationId ?? null, report_type: reportType, title, report_month: reportMonth, care_plan_id: plan?.id ?? null, content: baseContent, status: "draft" })
      .select().single();
    if (ie) throw new Error("帳票の保存に失敗しました: " + ie.message);
    return doc as ReportDoc;
  }

  const content = buildDefaultContent(reportType, user as KaigoUser, cert, plan, services, reportMonth);
  const today = format(new Date(), "yyyy-MM-dd");
  const title = config.needsPeriod && reportMonth
    ? `${config.titleJa}（${fmtJaYear(reportMonth + "-01")}）`
    : `${config.titleJa}　${fmtDate(today)}`;

  const { data: doc, error: ie } = await supabase
    .from("kaigo_report_documents")
    .insert({
      user_id: userId,
      certification_id: certificationId ?? null,
      report_type: reportType,
      title,
      report_month: reportMonth,
      care_plan_id: plan?.id ?? null,
      content,
      status: "draft",
    })
    .select()
    .single();

  if (ie) throw new Error("帳票の保存に失敗しました: " + ie.message);
  return doc as ReportDoc;
}

// ---------------------------------------------------------------------------
// Document list panel
// ---------------------------------------------------------------------------

function DocList({ docs, loading, selectedId, onSelect, onNew, newLoading }: {
  docs: ReportDoc[]; loading: boolean; selectedId: string | null;
  onSelect: (doc: ReportDoc) => void; onNew: () => void; newLoading: boolean;
}) {
  return (
    <div className="mb-4 rounded-xl border bg-white shadow-sm no-print">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-700">保存済み帳票</h2>
        <button onClick={onNew} disabled={newLoading}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
          {newLoading ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
          新規作成
        </button>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-8 text-gray-400">
          <Loader2 size={20} className="animate-spin mr-2" /> 読み込み中...
        </div>
      ) : docs.length === 0 ? (
        <div className="py-8 text-center text-sm text-gray-400">
          帳票がありません。「新規作成」で自動生成できます。
        </div>
      ) : (
        <div className="divide-y max-h-48 overflow-y-auto">
          {docs.map((doc) => (
            <button key={doc.id} onClick={() => onSelect(doc)}
              className={`w-full flex items-center justify-between px-4 py-2.5 text-left transition-colors hover:bg-gray-50 ${selectedId === doc.id ? "bg-blue-50" : ""}`}>
              <div>
                <div className="text-sm font-medium text-gray-800">{doc.title}</div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {fmtDate(doc.updated_at)} 更新
                </div>
              </div>
              <span className={`ml-3 flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${doc.status === "completed" ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"}`}>
                {doc.status === "completed" ? <CheckCircle size={10} /> : <Clock size={10} />}
                {doc.status === "completed" ? "完成" : "下書き"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit/View panel
// ---------------------------------------------------------------------------

function PreviewScaler({ paperWidth, paperMinHeight, paperPadding, children }: {
  paperWidth: string; paperMinHeight: string; paperPadding: string; children: React.ReactNode;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateScale = () => {
      const containerW = el.clientWidth - 32;
      const mmVal = parseFloat(paperWidth);
      const paperPx = mmVal * 3.78;
      setScale(Math.min(1, containerW / paperPx));
    };
    updateScale();
    const ro = new ResizeObserver(updateScale);
    ro.observe(el);
    return () => ro.disconnect();
  }, [paperWidth]);

  const mmVal = parseFloat(paperWidth);
  const paperPx = mmVal * 3.78;
  const mmH = parseFloat(paperMinHeight);
  const paperHPx = mmH * 3.78;

  return (
    <div ref={containerRef} className="no-print px-4 pb-4" style={{ overflow: "hidden" }}>
      <div style={{ width: `${paperPx * scale}px`, height: `${paperHPx * scale}px`, margin: "0 auto" }}>
        <div
          id="print-area"
          className="bg-white shadow"
          style={{
            width: paperWidth,
            minHeight: paperMinHeight,
            padding: paperPadding,
            fontFamily: '"MS Mincho","游明朝","Hiragino Mincho ProN",serif',
            fontSize: "9pt",
            color: "#000",
            boxSizing: "border-box",
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function DocEditor({ doc, config, onSave, onStatusToggle, onDirtyChange }: {
  doc: ReportDoc; config: ReportConfig;
  onSave: (content: Record<string, unknown>) => Promise<void>;
  onStatusToggle: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [content, setContent] = useState<Record<string, unknown>>(doc.content ?? {});
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [dirty, setDirty] = useState(false);
  const isLandscape = config.landscape ?? false;
  const paperWidth = isLandscape ? "297mm" : "210mm";
  const paperMinHeight = isLandscape ? "210mm" : "297mm";
  const paperPadding = isLandscape ? "8mm 10mm" : "10mm 12mm";

  // Reset when doc changes
  useEffect(() => {
    setContent(doc.content ?? {});
    setDirty(false);
  }, [doc.id, doc.content]);

  const handleChange = (c: Record<string, unknown>) => { setContent(c); setDirty(true); onDirtyChange?.(true); };

  const handleSave = async () => {
    setSaving(true);
    try { await onSave(content); setDirty(false); } finally { setSaving(false); }
  };

  const handleToggle = async () => {
    setToggling(true);
    try { await onStatusToggle(); } finally { setToggling(false); }
  };

  return (
    <div className="rounded-xl border bg-white shadow-sm">
      {/* Toolbar */}
      <div className="no-print flex items-center justify-between border-b px-4 py-3 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <FileText size={16} className="text-gray-400 shrink-0" />
          <span className="text-sm font-semibold text-gray-800 truncate">{doc.title}</span>
          <span className={`ml-1 flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium shrink-0 ${doc.status === "completed" ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"}`}>
            {doc.status === "completed" ? <CheckCircle size={10} /> : <Clock size={10} />}
            {doc.status === "completed" ? "完成" : "下書き"}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={handleToggle} disabled={toggling}
            className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors">
            {toggling ? <Loader2 size={12} className="animate-spin" /> : <Pencil size={12} />}
            {doc.status === "completed" ? "下書きに戻す" : "完成にする"}
          </button>
          <button onClick={handleSave} disabled={saving || !dirty}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-50 ${dirty ? "bg-green-600 hover:bg-green-700" : "bg-gray-400"}`}>
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            {saving ? "保存中..." : dirty ? "保存する" : "保存済み"}
          </button>
          <button onClick={() => window.print()}
            className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors">
            <Printer size={12} /> 印刷
          </button>
        </div>
      </div>

      {/* Edit form */}
      <div className="no-print border-b bg-gray-50">
        <EditForm reportType={doc.report_type} content={content} onChange={handleChange} />
      </div>

      {/* Print preview — scales to fit container width */}
      <div className="no-print px-4 py-2 text-xs text-gray-400 flex items-center gap-1">
        <Printer size={11} /> 印刷プレビュー（A4{isLandscape ? "横" : "縦"}）
      </div>
      <PreviewScaler paperWidth={paperWidth} paperMinHeight={paperMinHeight} paperPadding={paperPadding}>
        <PrintView reportType={doc.report_type} content={content} config={config} />
      </PreviewScaler>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function ReportTypePage() {
  const params = useParams();
  const reportType = typeof params.type === "string" ? params.type : "";
  const config = REPORT_CONFIG[reportType];
  const supabase = createClient();

  // URLパラメータから利用者IDを復元
  const [selectedUserId, setSelectedUserId] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      const sp = new URLSearchParams(window.location.search);
      return sp.get("user") || null;
    }
    return null;
  });
  const [selectedYearMonth, setSelectedYearMonth] = useState(format(new Date(), "yyyy-MM"));
  const [docs, setDocs] = useState<ReportDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<ReportDoc | null>(null);
  const [newLoading, setNewLoading] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [certifications, setCertifications] = useState<Certification[]>([]);
  const [selectedCertId, setSelectedCertId] = useState<string | null>(null);

  // 認定期間連動型の帳票タイプ（アセスメントと同じ扱い）
  const isCertLinked = ["care-plan-1", "care-plan-2", "care-plan-3"].includes(reportType);

  // Load certifications when user selected
  useEffect(() => {
    if (!selectedUserId || !isCertLinked) { setCertifications([]); setSelectedCertId(null); return; }
    supabase.from("kaigo_care_certifications")
      .select("id, care_level, start_date, end_date")
      .eq("user_id", selectedUserId)
      .order("start_date", { ascending: false })
      .then(({ data }: { data: Certification[] | null }) => {
        const certs = data ?? [];
        setCertifications(certs);
        // 切替先利用者の認定一覧に現在のCertIdが無ければ最新認定を自動選択
        if (certs.length === 0) {
          setSelectedCertId(null);
        } else if (!selectedCertId || !certs.some((c) => c.id === selectedCertId)) {
          setSelectedCertId(certs[0].id);
        }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUserId, isCertLinked]);

  // Month options
  const monthOptions: string[] = [];
  for (let i = -12; i <= 2; i++) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + i);
    monthOptions.push(format(d, "yyyy-MM"));
  }
  monthOptions.sort((a, b) => b.localeCompare(a));

  // URLパラメータからの初期ユーザーがいればデータをロード
  useEffect(() => {
    if (selectedUserId) {
      handleUserSelect(selectedUserId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load docs when user selected
  const loadDocs = useCallback(async (userId: string) => {
    setDocsLoading(true);
    setSelectedDoc(null);
    try {
      let query = supabase
        .from("kaigo_report_documents")
        .select("*")
        .eq("user_id", userId)
        .eq("report_type", reportType);
      if (isCertLinked && selectedCertId) {
        query = query.eq("certification_id", selectedCertId);
      }
      const { data, error } = await query.order("updated_at", { ascending: false });
      if (error) throw error;
      setDocs(data as ReportDoc[] ?? []);
    } catch (e) {
      toast.error("帳票一覧の取得に失敗しました");
      console.error(e);
    } finally {
      setDocsLoading(false);
    }
  }, [supabase, reportType, isCertLinked, selectedCertId]);

  // 認定期間が変更されたらドキュメントを再読込
  useEffect(() => {
    if (selectedUserId && isCertLinked) {
      loadDocs(selectedUserId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCertId]);

  const handleUserSelect = async (userId: string) => {
    setSelectedUserId(userId);
    setDocsLoading(true);
    setSelectedDoc(null);
    try {
      const { data, error } = await supabase
        .from("kaigo_report_documents")
        .select("*")
        .eq("user_id", userId)
        .eq("report_type", reportType)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      const existingDocs = (data as ReportDoc[]) ?? [];

      if (existingDocs.length > 0) {
        // 保存済みがあれば最新を表示
        setDocs(existingDocs);
        setSelectedDoc(existingDocs[0]);
      } else {
        // なければ自動生成して表示
        setDocs([]);
        const doc = await autoGenerateDoc(
          supabase, userId, reportType,
          config?.needsPeriod ? selectedYearMonth : null,
          config!,
          isCertLinked ? selectedCertId : null,
        );
        if (doc) {
          setDocs([doc]);
          setSelectedDoc(doc);
        }
      }
    } catch (e) {
      toast.error("帳票の取得に失敗しました");
      console.error(e);
    } finally {
      setDocsLoading(false);
    }
  };

  const handleNewDoc = async () => {
    if (!selectedUserId || !config) return;
    setNewLoading(true);
    try {
      const doc = await autoGenerateDoc(
        supabase, selectedUserId, reportType,
        config.needsPeriod ? selectedYearMonth : null,
        config,
        isCertLinked ? selectedCertId : null,
      );
      if (doc) {
        toast.success("帳票を新規作成しました");
        await loadDocs(selectedUserId);
        setSelectedDoc(doc);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "帳票の作成に失敗しました");
    } finally {
      setNewLoading(false);
    }
  };

  const handleSelectDoc = (doc: ReportDoc) => setSelectedDoc(doc);

  const handleSave = async (content: Record<string, unknown>) => {
    if (!selectedDoc) return;
    const { data, error } = await supabase
      .from("kaigo_report_documents")
      .update({ content, updated_at: new Date().toISOString() })
      .eq("id", selectedDoc.id)
      .select()
      .single();
    if (error) { toast.error("保存に失敗しました: " + error.message); throw error; }
    toast.success("保存しました");
    const updated = data as ReportDoc;
    setSelectedDoc(updated);
    setDocs((prev) => prev.map((d) => d.id === updated.id ? updated : d));
    setHasUnsavedChanges(false);
  };

  const handleStatusToggle = async () => {
    if (!selectedDoc) return;
    const newStatus = selectedDoc.status === "completed" ? "draft" : "completed";
    const { data, error } = await supabase
      .from("kaigo_report_documents")
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq("id", selectedDoc.id)
      .select()
      .single();
    if (error) { toast.error("ステータスの変更に失敗しました"); return; }
    toast.success(newStatus === "completed" ? "完成にしました" : "下書きに戻しました");
    const updated = data as ReportDoc;
    setSelectedDoc(updated);
    setDocs((prev) => prev.map((d) => d.id === updated.id ? updated : d));
  };

  if (!config) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-gray-500">
        <AlertTriangle size={40} className="mb-3 text-amber-400" />
        <p className="text-lg font-semibold text-gray-700">不明な帳票種別です</p>
        <Link href="/reports" className="mt-4 text-sm text-blue-600 hover:underline">帳票一覧に戻る</Link>
      </div>
    );
  }

  const printStyle = config.landscape ? PRINT_STYLE_LANDSCAPE : PRINT_STYLE_PORTRAIT;

  return (
    <>
      <style>{printStyle}</style>
      <div className="flex h-full -m-6">
        <UserSidebar selectedUserId={selectedUserId} onSelectUser={handleUserSelect} />

        <div className="flex-1 overflow-y-auto p-6">
          {/* Header with report navigation */}
          {(() => {
            const reportOrder = Object.keys(REPORT_CONFIG);
            const currentIdx = reportOrder.indexOf(reportType);
            const prevType = currentIdx > 0 ? reportOrder[currentIdx - 1] : null;
            const nextType = currentIdx < reportOrder.length - 1 ? reportOrder[currentIdx + 1] : null;
            const navigateTo = (type: string) => {
              if (hasUnsavedChanges) {
                if (!window.confirm("保存されていない変更があります。破棄して移動しますか？")) return;
              }
              const sp = new URLSearchParams();
              if (selectedUserId) sp.set("user", selectedUserId);
              // メインサイドバーの開閉状態を引き継ぎ
              const currentSp = new URLSearchParams(window.location.search);
              if (currentSp.has("nav")) sp.set("nav", currentSp.get("nav")!);
              window.location.href = `/reports/${type}?${sp.toString()}`;
            };
            return (
              <div className="no-print mb-4 flex items-center justify-between">
                <button
                  onClick={() => prevType && navigateTo(prevType)}
                  disabled={!prevType}
                  className="flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronLeft size={16} />
                  {prevType ? REPORT_CONFIG[prevType]?.titleJa ?? "" : ""}
                </button>
                <div className="text-center">
                  <h1 className="text-lg font-bold text-gray-900">{config.titleJa}</h1>
                  <p className="text-xs text-gray-400">
                    {currentIdx + 1} / {reportOrder.length}
                    {config.landscape && <span className="ml-2 rounded bg-blue-100 px-1 py-0.5 text-blue-600 text-[10px]">A4横</span>}
                  </p>
                </div>
                <button
                  onClick={() => nextType && navigateTo(nextType)}
                  disabled={!nextType}
                  className="flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  {nextType ? REPORT_CONFIG[nextType]?.titleJa ?? "" : ""}
                  <ChevronRight size={16} />
                </button>
              </div>
            );
          })()}

          {!selectedUserId ? (
            <div className="flex flex-col items-center justify-center py-24 text-gray-400 no-print">
              <FileText size={48} className="mb-4 text-gray-300" />
              <p className="text-base font-medium">左側のリストから利用者を選択してください</p>
            </div>
          ) : (
            <>
              {/* Month selector + 帳票一覧ボタン */}
              <div className="no-print mb-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {config.needsPeriod && (
                    <>
                      <label className="text-xs font-medium text-gray-600 flex items-center gap-1">
                        <CalendarDays size={12} /> 対象月
                      </label>
                      <select value={selectedYearMonth} onChange={(e) => setSelectedYearMonth(e.target.value)}
                        className="rounded-lg border px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500">
                        {monthOptions.map((ym) => (
                          <option key={ym} value={ym}>{fmtJaYear(ym + "-01")}</option>
                        ))}
                      </select>
                    </>
                  )}
                </div>
                <Link href="/reports"
                  className="flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-50 transition-colors">
                  <FileText size={14} /> 帳票一覧
                </Link>
              </div>

              {/* 認定期間タブ（計画書1/2/3のみ） */}
              {isCertLinked && certifications.length > 0 && (
                <div className="mb-3 border-b overflow-x-auto no-print">
                  <div className="flex gap-1 min-w-max">
                    {certifications.map((cert) => {
                      const fmt = (d: string) => format(new Date(d), "yyyy/M/d");
                      const isActive = selectedCertId === cert.id;
                      return (
                        <button
                          key={cert.id}
                          onClick={() => setSelectedCertId(cert.id)}
                          className={`flex flex-col px-4 py-2 text-xs border-b-2 whitespace-nowrap transition-colors ${
                            isActive
                              ? "border-blue-600 text-blue-700 bg-blue-50 font-semibold"
                              : "border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                          }`}
                        >
                          <span className="font-bold">{cert.care_level}</span>
                          <span className="text-[10px] text-gray-500">{fmt(cert.start_date)} 〜 {fmt(cert.end_date)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {isCertLinked && certifications.length === 0 && (
                <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 no-print">
                  介護認定情報が登録されていません。先に利用者情報で認定情報を登録してください。
                </div>
              )}

              {/* Document list */}
              <DocList
                docs={docs} loading={docsLoading} selectedId={selectedDoc?.id ?? null}
                onSelect={handleSelectDoc} onNew={handleNewDoc} newLoading={newLoading}
              />

              {/* Editor */}
              {selectedDoc && (
                <DocEditor
                  doc={selectedDoc} config={config}
                  onSave={handleSave} onStatusToggle={handleStatusToggle}
                  onDirtyChange={setHasUnsavedChanges}
                />
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
