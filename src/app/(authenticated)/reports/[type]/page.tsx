"use client";

import { useParams } from "next/navigation";
import React, { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  Printer, Loader2, AlertTriangle, FileText, Plus, ChevronLeft,
  Save, CheckCircle, Clock, Pencil, X, CalendarDays,
} from "lucide-react";
import Link from "next/link";
import { UserSidebar } from "@/components/users/user-sidebar";
import { format, parseISO, differenceInYears } from "date-fns";
import { ja } from "date-fns/locale";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ReportDoc = {
  id: string;
  user_id: string;
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
  "face-sheet":        { titleJa: "フェースシート",                    needsPeriod: false },
  "care-plan-1":       { titleJa: "居宅サービス計画書（第1表）",        needsPeriod: false, landscape: true },
  "care-plan-2":       { titleJa: "居宅サービス計画書（第2表）",        needsPeriod: false, landscape: true },
  "care-plan-3":       { titleJa: "週間サービス計画表（第3表）",        needsPeriod: false, landscape: true },
  "service-usage":     { titleJa: "サービス利用票",                    needsPeriod: true,  landscape: true },
  "service-provision": { titleJa: "サービス提供票",                    needsPeriod: true,  landscape: true },
  "invoice":           { titleJa: "請求書",                           needsPeriod: true },
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

// ---------------------------------------------------------------------------
// Default content builders (for auto-generation)
// ---------------------------------------------------------------------------

function buildDefaultContent(
  reportType: string,
  user: KaigoUser,
  cert: CareCertification | null,
  plan: CarePlan | null,
  services: CarePlanService[],
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
    case "care-plan-2":
      return {
        user_name: user.name,
        creation_date: fmtReiwa(plan?.start_date ?? today),
        needs: plan?.long_term_goals ?? "",
        long_term_goal: plan?.long_term_goals ?? "",
        long_term_period: plan ? `${fmtReiwa(plan.start_date)}〜${fmtReiwa(plan.end_date)}` : "",
        short_term_goal: plan?.short_term_goals ?? "",
        short_term_period: plan ? `${fmtReiwa(plan.start_date)}〜${fmtReiwa(plan.end_date)}` : "",
        services: services.map((s) => ({
          content: s.service_content,
          insurance_flag: "○",
          type: s.service_type,
          provider: s.provider ?? "",
          frequency: s.frequency ?? "",
          period: s.start_date && s.end_date ? `${fmtReiwa(s.start_date)}〜${fmtReiwa(s.end_date)}` : "",
        })),
      };
    case "face-sheet":
      return {
        user_name: user.name, birth_date: user.birth_date ?? "", gender: user.gender,
        address: [user.postal_code ? `〒${user.postal_code}` : "", user.address ?? ""].filter(Boolean).join(" "),
        phone: user.phone ?? "",
        care_level: cert?.care_level ?? "", cert_period: cert ? `${fmtReiwa(cert.start_date)}〜${fmtReiwa(cert.end_date)}` : "",
        family_members: [],
        medical_history: [],
        adl_summary: "", health_notes: "", special_notes: user.notes ?? "",
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

type Svc2 = { content: string; insurance_flag: string; type: string; provider: string; frequency: string; period: string };

function EditFormCarePlan2({ content, onChange }: {
  content: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
}) {
  const s = (key: string) => (String(content[key] ?? ""));
  const set = (key: string, v: string) => onChange({ ...content, [key]: v });
  const services: Svc2[] = Array.isArray(content.services) ? (content.services as Svc2[]) : [];

  const updateSvc = (i: number, key: keyof Svc2, v: string) => {
    const updated = services.map((svc, idx) => idx === i ? { ...svc, [key]: v } : svc);
    onChange({ ...content, services: updated });
  };
  const addSvc = () => onChange({ ...content, services: [...services, { content: "", insurance_flag: "○", type: "", provider: "", frequency: "", period: "" }] });
  const removeSvc = (i: number) => onChange({ ...content, services: services.filter((_, idx) => idx !== i) });

  return (
    <div className="grid grid-cols-2 gap-3 p-4">
      <div className="col-span-2 grid grid-cols-4 gap-3">
        <FI label="利用者名" value={s("user_name")} onChange={(v) => set("user_name", v)} />
        <FI label="計画作成日" value={s("creation_date")} onChange={(v) => set("creation_date", v)} />
      </div>
      <FI label="生活全般の解決すべき課題（ニーズ）" value={s("needs")}
        onChange={(v) => set("needs", v)} textarea rows={3} className="col-span-2" />
      <div className="col-span-2 grid grid-cols-2 gap-3">
        <FI label="長期目標" value={s("long_term_goal")} onChange={(v) => set("long_term_goal", v)} textarea rows={2} />
        <FI label="長期目標（期間）" value={s("long_term_period")} onChange={(v) => set("long_term_period", v)} />
      </div>
      <div className="col-span-2 grid grid-cols-2 gap-3">
        <FI label="短期目標" value={s("short_term_goal")} onChange={(v) => set("short_term_goal", v)} textarea rows={2} />
        <FI label="短期目標（期間）" value={s("short_term_period")} onChange={(v) => set("short_term_period", v)} />
      </div>
      <div className="col-span-2">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-600">援助内容・サービス一覧</span>
          <button onClick={addSvc} className="flex items-center gap-1 rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-100">
            <Plus size={12} /> 行を追加
          </button>
        </div>
        <div className="space-y-2">
          {services.map((svc, i) => (
            <div key={i} className="relative grid grid-cols-6 gap-2 rounded border border-gray-200 bg-gray-50 p-2">
              <button onClick={() => removeSvc(i)} className="absolute right-1 top-1 text-gray-300 hover:text-red-400"><X size={12} /></button>
              <FI label="サービス内容" value={svc.content} onChange={(v) => updateSvc(i, "content", v)} className="col-span-2" />
              <FI label="保険給付区分※1" value={svc.insurance_flag} onChange={(v) => updateSvc(i, "insurance_flag", v)} />
              <FI label="サービス種別" value={svc.type} onChange={(v) => updateSvc(i, "type", v)} />
              <FI label="事業所名※2" value={svc.provider} onChange={(v) => updateSvc(i, "provider", v)} />
              <FI label="頻度" value={svc.frequency} onChange={(v) => updateSvc(i, "frequency", v)} />
              <FI label="期間" value={svc.period} onChange={(v) => updateSvc(i, "period", v)} className="col-span-2" />
            </div>
          ))}
          {services.length === 0 && (
            <div className="rounded border-2 border-dashed border-gray-200 py-4 text-center text-sm text-gray-400">
              サービスがありません。「行を追加」で追加してください。
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
  const s = (k: string) => String(c[k] ?? "　");
  return (
    <div style={{ fontFamily: '"MS Mincho","游明朝","Hiragino Mincho ProN",serif', fontSize: "9pt", color: "#000" }}>
      <div style={{ textAlign: "center", marginBottom: "4px" }}>
        <div style={{ fontSize: "12pt", fontWeight: "bold", letterSpacing: "0.2em" }}>居宅サービス計画書（1）</div>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "2px" }}>
        <tbody>
          <tr style={{ height: "20px" }}>
            <TH style={{ width: "18%" }}>初回・紹介・継続</TH>
            <TD style={{ width: "37%" }} className="px-2">
              {["初回","紹介","継続"].map((t) => <span key={t} style={{ marginRight: "12px" }}>{s("plan_type") === t ? "☑" : "□"}　{t}</span>)}
            </TD>
            <TH style={{ width: "18%" }}>認定済・申請中</TH>
            <TD style={{ width: "27%" }} className="px-2">
              {["認定済","申請中"].map((t) => <span key={t} style={{ marginRight: "12px" }}>{s("cert_status") === t ? "☑" : "□"}　{t}</span>)}
            </TD>
          </tr>
        </tbody>
      </table>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "2px" }}>
        <colgroup><col style={{ width: "22%" }} /><col style={{ width: "28%" }} /><col style={{ width: "22%" }} /><col style={{ width: "28%" }} /></colgroup>
        <tbody>
          <tr style={{ height: "22px" }}>
            <TH>利用者名</TH><TD className="px-1 font-bold">{s("user_name")}　様</TD>
            <TH>居宅サービス計画作成者氏名</TH><TD className="px-1">{s("creator_name")}</TD>
          </tr>
          <tr style={{ height: "22px" }}>
            <TH>生年月日</TH><TD className="px-1">{s("birth_date") ? fmtReiwa(s("birth_date")) : "　"}　({s("birth_date") ? calcAge(s("birth_date")) : "　"})</TD>
            <TH>居宅介護支援事業者・事業所名及び所在地</TH><TD className="px-1" rowSpan={2}>{s("office_name")}</TD>
          </tr>
          <tr style={{ height: "22px" }}><TH>住所</TH><TD className="px-1">{s("address")}</TD></tr>
          <tr style={{ height: "22px" }}>
            <TH>居宅サービス計画作成（変更）日</TH><TD className="px-1">{s("creation_date")}</TD>
            <TH>初回居宅サービス計画作成日</TH><TD className="px-1">{s("initial_creation_date")}</TD>
          </tr>
          <tr style={{ height: "22px" }}>
            <TH>認定有効期間</TH><TD colSpan={3} className="px-2">{s("cert_period")}</TD>
          </tr>
          <tr style={{ height: "22px" }}>
            <TH>要介護状態区分</TH>
            <TD colSpan={3} className="px-2">
              {CARE_LEVELS.map((lv) => <span key={lv} style={{ marginRight: "8px" }}>{s("care_level") === lv ? "☑" : "□"}　{lv}</span>)}
            </TD>
          </tr>
        </tbody>
      </table>
      {[
        { label: "利用者及び家族の生活に対する意向を踏まえた課題分析の結果", key: "issue_analysis", h: "60px" },
        { label: "介護認定審査会の意見及びサービスの種類の指定", key: "review_opinion", h: "40px" },
        { label: "総合的な援助の方針", key: "overall_policy", h: "60px" },
      ].map(({ label, key, h }) => (
        <table key={key} style={{ width: "100%", borderCollapse: "collapse", marginBottom: "2px" }}>
          <tbody>
            <tr>
              <TH style={{ width: "30%", padding: "2px 4px" }}>{label}</TH>
              <TD style={{ width: "70%", height: h, verticalAlign: "top", padding: "4px", whiteSpace: "pre-wrap" }}>{s(key)}</TD>
            </tr>
          </tbody>
        </table>
      ))}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "6px" }}>
        <tbody>
          <tr style={{ height: "22px" }}>
            <TH style={{ width: "30%", padding: "2px 4px" }}>生活援助中心型の算定理由</TH>
            <TD style={{ width: "70%" }} className="px-3">{s("living_support_reason") || <span style={{ color: "#888" }}>□ 1．一人暮らし　□ 2．家族等が障害・疾病等　□ 3．その他（　　　　　　）</span>}</TD>
          </tr>
        </tbody>
      </table>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          <tr style={{ height: "24px" }}><TH style={{ width: "15%" }}>介護支援専門員氏名</TH><TD style={{ width: "35%" }} className="px-2" /><TH style={{ width: "15%" }}>事業所名</TH><TD style={{ width: "35%" }} className="px-2">{s("office_name")}</TD></tr>
          <tr style={{ height: "28px" }}><TH>利用者同意署名</TH><TD className="px-2" /><TH>家族等署名</TH><TD className="px-2" /></tr>
        </tbody>
      </table>
    </div>
  );
}

function PrintCarePlan2({ c }: { c: Record<string, unknown> }) {
  const s = (k: string) => String(c[k] ?? "　");
  const services: Svc2[] = Array.isArray(c.services) ? (c.services as Svc2[]) : [];
  const rows = services.length > 0 ? services : [{ content: "", insurance_flag: "", type: "", provider: "", frequency: "", period: "" }];
  return (
    <div style={{ fontFamily: '"MS Mincho","游明朝","Hiragino Mincho ProN",serif', fontSize: "8pt", color: "#000" }}>
      <div style={{ textAlign: "center", marginBottom: "4px" }}>
        <div style={{ fontSize: "11pt", fontWeight: "bold", letterSpacing: "0.2em" }}>居宅サービス計画書（2）</div>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "3px" }}>
        <tbody>
          <tr style={{ height: "20px" }}>
            <TH style={{ width: "10%" }}>利用者名</TH>
            <TD style={{ width: "25%" }} className="px-1 font-bold">{s("user_name")}　様</TD>
            <TH style={{ width: "12%" }}>計画作成日</TH>
            <TD className="px-1">{s("creation_date")}</TD>
          </tr>
        </tbody>
      </table>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ height: "28px" }}>
            <TH style={{ width: "14%" }} rowSpan={2}>生活全般の解決す<br />べき課題（ニーズ）</TH>
            <TH colSpan={4}>目標</TH>
            <TH colSpan={6}>援助内容</TH>
          </tr>
          <tr style={{ height: "24px" }}>
            <TH style={{ width: "11%" }}>長期目標</TH>
            <TH style={{ width: "7%" }}>（期間）</TH>
            <TH style={{ width: "11%" }}>短期目標</TH>
            <TH style={{ width: "7%" }}>（期間）</TH>
            <TH style={{ width: "14%" }}>サービス内容</TH>
            <TH style={{ width: "3%" }}>※1</TH>
            <TH style={{ width: "9%" }}>サービス種別</TH>
            <TH style={{ width: "3%" }}>※2</TH>
            <TH style={{ width: "5%" }}>頻度</TH>
            <TH style={{ width: "7%" }}>期間</TH>
          </tr>
        </thead>
        <tbody>
          {rows.map((svc, i) => (
            <tr key={i} style={{ minHeight: "28px" }}>
              {i === 0 && <TD rowSpan={rows.length} className="px-1 align-top" style={{ verticalAlign: "top", whiteSpace: "pre-wrap" }}>{s("needs")}</TD>}
              {i === 0 && <TD rowSpan={rows.length} className="px-1 align-top" style={{ verticalAlign: "top", whiteSpace: "pre-wrap" }}>{s("long_term_goal")}</TD>}
              {i === 0 && <TD rowSpan={rows.length} className="px-1 align-top" style={{ verticalAlign: "top", fontSize: "7pt" }}>{s("long_term_period")}</TD>}
              {i === 0 && <TD rowSpan={rows.length} className="px-1 align-top" style={{ verticalAlign: "top", whiteSpace: "pre-wrap" }}>{s("short_term_goal")}</TD>}
              {i === 0 && <TD rowSpan={rows.length} className="px-1 align-top" style={{ verticalAlign: "top", fontSize: "7pt" }}>{s("short_term_period")}</TD>}
              <TD className="px-1" style={{ verticalAlign: "top" }}>{svc.content}</TD>
              <TD className="px-1 text-center">{svc.insurance_flag}</TD>
              <TD className="px-1 text-center">{svc.type}</TD>
              <TD className="px-1 text-center" style={{ fontSize: "7pt" }}>{svc.provider}</TD>
              <TD className="px-1 text-center">{svc.frequency}</TD>
              <TD className="px-1 text-center" style={{ fontSize: "7pt" }}>{svc.period}</TD>
            </tr>
          ))}
        </tbody>
      </table>
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "6px" }}>
        <tbody>
          <tr style={{ height: "22px" }}>
            <TH style={{ width: "15%" }}>作成者（介護支援専門員）</TH>
            <TD style={{ width: "35%" }} className="px-2" />
            <TH style={{ width: "15%" }}>事業所名</TH>
            <TD style={{ width: "35%" }} className="px-2" />
          </tr>
        </tbody>
      </table>
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
    case "care-plan-1": return <PrintCarePlan1 c={content} />;
    case "care-plan-2": return <PrintCarePlan2 c={content} />;
    default: return <PrintGeneric c={content} title={config.titleJa} />;
  }
}

function EditForm({ reportType, content, onChange }: {
  reportType: string; content: Record<string, unknown>; onChange: (c: Record<string, unknown>) => void;
}) {
  switch (reportType) {
    case "care-plan-1": return <EditFormCarePlan1 content={content} onChange={onChange} />;
    case "care-plan-2": return <EditFormCarePlan2 content={content} onChange={onChange} />;
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
  const plan: CarePlan | null = planArr?.[0] ?? null;

  // Fetch services
  let services: CarePlanService[] = [];
  if (plan) {
    const { data: svcs } = await supabase
      .from("kaigo_care_plan_services").select("*").eq("care_plan_id", plan.id).order("service_type");
    services = svcs ?? [];
  }

  const content = buildDefaultContent(reportType, user as KaigoUser, cert, plan, services);
  const today = format(new Date(), "yyyy-MM-dd");
  const title = config.needsPeriod && reportMonth
    ? `${config.titleJa}（${fmtJaYear(reportMonth + "-01")}）`
    : `${config.titleJa}　${fmtDate(today)}`;

  const { data: doc, error: ie } = await supabase
    .from("kaigo_report_documents")
    .insert({
      user_id: userId,
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

function DocEditor({ doc, config, onSave, onStatusToggle }: {
  doc: ReportDoc; config: ReportConfig;
  onSave: (content: Record<string, unknown>) => Promise<void>;
  onStatusToggle: () => Promise<void>;
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

  const handleChange = (c: Record<string, unknown>) => { setContent(c); setDirty(true); };

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

      {/* Print preview */}
      <div className="no-print px-4 py-2 text-xs text-gray-400 flex items-center gap-1">
        <Printer size={11} /> 印刷プレビュー（A4{isLandscape ? "横" : "縦"}）
      </div>
      <div className="overflow-x-auto px-4 pb-4">
        <div id="print-area" className="mx-auto bg-white shadow"
          style={{ width: paperWidth, minHeight: paperMinHeight, padding: paperPadding,
            fontFamily: '"MS Mincho","游明朝","Hiragino Mincho ProN",serif', fontSize: "9pt",
            color: "#000", boxSizing: "border-box" }}>
          <PrintView reportType={doc.report_type} content={content} config={config} />
        </div>
      </div>
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

  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedYearMonth, setSelectedYearMonth] = useState(format(new Date(), "yyyy-MM"));
  const [docs, setDocs] = useState<ReportDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<ReportDoc | null>(null);
  const [newLoading, setNewLoading] = useState(false);

  // Month options
  const monthOptions: string[] = [];
  for (let i = -12; i <= 2; i++) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + i);
    monthOptions.push(format(d, "yyyy-MM"));
  }
  monthOptions.sort((a, b) => b.localeCompare(a));

  // Load docs when user selected
  const loadDocs = useCallback(async (userId: string) => {
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
      setDocs(data as ReportDoc[] ?? []);
    } catch (e) {
      toast.error("帳票一覧の取得に失敗しました");
      console.error(e);
    } finally {
      setDocsLoading(false);
    }
  }, [supabase, reportType]);

  const handleUserSelect = (userId: string) => {
    setSelectedUserId(userId);
    loadDocs(userId);
  };

  const handleNewDoc = async () => {
    if (!selectedUserId || !config) return;
    setNewLoading(true);
    try {
      const doc = await autoGenerateDoc(
        supabase, selectedUserId, reportType,
        config.needsPeriod ? selectedYearMonth : null,
        config,
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
          {/* Header */}
          <div className="no-print mb-5 flex items-center gap-4">
            <Link href="/reports"
              className="flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors">
              <ChevronLeft size={16} /> 帳票一覧
            </Link>
            <div>
              <h1 className="text-xl font-bold text-gray-900">{config.titleJa}</h1>
              <p className="text-xs text-gray-500 mt-0.5">
                公式様式　編集・保存・印刷
                {config.landscape && <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-blue-700">横向き（A4）</span>}
              </p>
            </div>
          </div>

          {!selectedUserId ? (
            <div className="flex flex-col items-center justify-center py-24 text-gray-400 no-print">
              <FileText size={48} className="mb-4 text-gray-300" />
              <p className="text-base font-medium">左側のリストから利用者を選択してください</p>
            </div>
          ) : (
            <>
              {/* Month selector (only for period reports) */}
              {config.needsPeriod && (
                <div className="no-print mb-4 flex items-center gap-3">
                  <label className="text-xs font-medium text-gray-600 flex items-center gap-1">
                    <CalendarDays size={12} /> 対象月
                  </label>
                  <select value={selectedYearMonth} onChange={(e) => setSelectedYearMonth(e.target.value)}
                    className="rounded-lg border px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500">
                    {monthOptions.map((ym) => (
                      <option key={ym} value={ym}>{fmtJaYear(ym + "-01")}</option>
                    ))}
                  </select>
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
                />
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
