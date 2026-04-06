"use client";

import { useParams } from "next/navigation";
import React, { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  Printer,
  ChevronLeft,
  Loader2,
  AlertTriangle,
  CalendarDays,
  FileText,
} from "lucide-react";
import Link from "next/link";
import { UserSidebar } from "@/components/users/user-sidebar";
import {
  format,
  parseISO,
  differenceInYears,
  getDaysInMonth,
  getDay,
} from "date-fns";
import { ja } from "date-fns/locale";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type KaigoUser = {
  id: string;
  name: string;
  name_kana: string;
  gender: string;
  birth_date: string;
  blood_type: string | null;
  postal_code: string | null;
  address: string | null;
  phone: string | null;
  mobile_phone: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  admission_date: string | null;
  notes: string | null;
};

type CareCertification = {
  id: string;
  care_level: string;
  start_date: string;
  end_date: string;
  certification_number: string | null;
  insurer_number: string | null;
  insured_number: string | null;
  support_limit_amount: number | null;
  status: string;
};

type MedicalInsurance = {
  id: string;
  insurance_type: string;
  insurer_number: string | null;
  insured_number: string | null;
  start_date: string | null;
  end_date: string | null;
  copay_rate: number;
};

type AdlRecord = {
  id: string;
  assessment_date: string;
  eating: number;
  transfer: number;
  grooming: number;
  toilet: number;
  bathing: number;
  mobility: number;
  stairs: number;
  dressing: number;
  bowel: number;
  bladder: number;
  total_score: number;
  assessor_name: string | null;
};

type MedicalHistory = {
  id: string;
  disease_name: string;
  onset_date: string | null;
  status: string;
  hospital: string | null;
  doctor: string | null;
};

type HealthRecord = {
  id: string;
  record_date: string;
  temperature: number | null;
  blood_pressure_sys: number | null;
  blood_pressure_dia: number | null;
  pulse: number | null;
  weight: number | null;
  height: number | null;
  spo2: number | null;
};

type FamilyContact = {
  id: string;
  name: string;
  relationship: string;
  phone: string | null;
  address: string | null;
  is_key_person: boolean;
};

type CarePlan = {
  id: string;
  plan_number: string;
  plan_type: string;
  start_date: string;
  end_date: string;
  long_term_goals: string | null;
  short_term_goals: string | null;
  status: string;
  created_by: string | null;
};

type CarePlanService = {
  id: string;
  service_type: string;
  service_content: string;
  frequency: string | null;
  provider: string | null;
  start_date: string | null;
  end_date: string | null;
  notes: string | null;
};

type ServiceRecord = {
  id: string;
  service_date: string;
  service_type: string;
  start_time: string | null;
  end_time: string | null;
  content: string | null;
};

type BillingRecord = {
  id: string;
  billing_month: string;
  service_type: string;
  total_units: number;
  unit_price: number;
  total_amount: number;
  insurance_amount: number;
  copay_amount: number;
  status: string;
};

type BillingDetail = {
  id: string;
  billing_record_id: string;
  service_date: string;
  service_code: string;
  service_name: string;
  units: number;
  amount: number;
};

// ---------------------------------------------------------------------------
// Report meta config
// ---------------------------------------------------------------------------

type ReportConfig = {
  titleJa: string;
  needsPeriod: boolean;
  landscape?: boolean;
};

const REPORT_CONFIG: Record<string, ReportConfig> = {
  "face-sheet": { titleJa: "フェースシート", needsPeriod: false },
  "care-plan-1": { titleJa: "居宅サービス計画書（第1表）", needsPeriod: false, landscape: true },
  "care-plan-2": { titleJa: "居宅サービス計画書（第2表）", needsPeriod: false, landscape: true },
  "care-plan-3": { titleJa: "週間サービス計画表（第3表）", needsPeriod: false, landscape: true },
  "service-usage": { titleJa: "サービス利用票", needsPeriod: true, landscape: true },
  "service-provision": { titleJa: "サービス提供票", needsPeriod: true, landscape: true },
  invoice: { titleJa: "請求書", needsPeriod: true },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(d: string | null | undefined): string {
  if (!d) return "　";
  try {
    return format(parseISO(d), "yyyy年M月d日", { locale: ja });
  } catch {
    return d;
  }
}

function fmtJaYear(d: string | null | undefined): string {
  if (!d) return "　";
  try {
    return format(parseISO(d), "yyyy年M月", { locale: ja });
  } catch {
    return d ?? "　";
  }
}

function fmtReiwa(d: string | null | undefined): string {
  if (!d) return "　　年　月　日";
  try {
    const date = parseISO(d);
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    // Reiwa starts 2019-05-01 (year 1)
    if (year >= 2019) {
      const reiwaYear = year - 2018;
      return `令和${reiwaYear}年${month}月${day}日`;
    } else if (year >= 1989) {
      const heiseiYear = year - 1988;
      return `平成${heiseiYear}年${month}月${day}日`;
    } else {
      return `${year}年${month}月${day}日`;
    }
  } catch {
    return d ?? "　";
  }
}

function fmtReiwaMonth(ym: string | null | undefined): string {
  if (!ym) return "　　年　月";
  try {
    const d = parseISO(ym + (ym.length === 7 ? "-01" : ""));
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    if (year >= 2019) {
      return `令和${year - 2018}年${month}月`;
    } else if (year >= 1989) {
      return `平成${year - 1988}年${month}月`;
    }
    return `${year}年${month}月`;
  } catch {
    return ym;
  }
}

function calcAge(birthDate: string): string {
  try {
    return `${differenceInYears(new Date(), parseISO(birthDate))}歳`;
  } catch {
    return "　";
  }
}

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat("ja-JP").format(n) + "円";
}

const CARE_LEVELS = [
  "要支援１",
  "要支援２",
  "要介護１",
  "要介護２",
  "要介護３",
  "要介護４",
  "要介護５",
];

// ---------------------------------------------------------------------------
// Common print styles
// ---------------------------------------------------------------------------

const PRINT_STYLE_PORTRAIT = `
@media print {
  body * { visibility: hidden !important; }
  #print-area, #print-area * { visibility: visible !important; }
  #print-area {
    position: fixed !important;
    inset: 0 !important;
    width: 210mm !important;
    min-height: 297mm !important;
    padding: 8mm 10mm !important;
    font-size: 9pt !important;
    color: #000 !important;
    background: #fff !important;
    overflow: visible !important;
  }
  .no-print { display: none !important; }
  table { border-collapse: collapse !important; }
  td, th {
    border: 1px solid #000 !important;
    padding: 1px 2px !important;
  }
  @page { size: A4 portrait; margin: 0; }
}
`;

const PRINT_STYLE_LANDSCAPE = `
@media print {
  body * { visibility: hidden !important; }
  #print-area, #print-area * { visibility: visible !important; }
  #print-area {
    position: fixed !important;
    inset: 0 !important;
    width: 297mm !important;
    min-height: 210mm !important;
    padding: 6mm 8mm !important;
    font-size: 8pt !important;
    color: #000 !important;
    background: #fff !important;
    overflow: visible !important;
  }
  .no-print { display: none !important; }
  table { border-collapse: collapse !important; }
  td, th {
    border: 1px solid #000 !important;
    padding: 1px 2px !important;
  }
  @page { size: A4 landscape; margin: 0; }
}
`;

// ---------------------------------------------------------------------------
// Small reusable cell helpers
// ---------------------------------------------------------------------------

const TH = ({
  children,
  className = "",
  colSpan,
  rowSpan,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  colSpan?: number;
  rowSpan?: number;
  style?: React.CSSProperties;
}) => (
  <th
    colSpan={colSpan}
    rowSpan={rowSpan}
    style={style}
    className={`border border-black bg-gray-100 text-center text-xs font-medium leading-tight ${className}`}
  >
    {children}
  </th>
);

const TD = ({
  children,
  className = "",
  colSpan,
  rowSpan,
  style,
}: {
  children?: React.ReactNode;
  className?: string;
  colSpan?: number;
  rowSpan?: number;
  style?: React.CSSProperties;
}) => (
  <td
    colSpan={colSpan}
    rowSpan={rowSpan}
    style={style}
    className={`border border-black text-xs leading-tight ${className}`}
  >
    {children ?? "　"}
  </td>
);

// ---------------------------------------------------------------------------
// 1. フェースシート（全国社会福祉協議会版）
// ---------------------------------------------------------------------------

function FaceSheetReport({
  user,
  cert,
  adl,
  histories,
  contacts,
  healthRecords,
}: {
  user: KaigoUser;
  cert: CareCertification | null;
  adl: AdlRecord | null;
  histories: MedicalHistory[];
  contacts: FamilyContact[];
  healthRecords: HealthRecord[];
}) {
  const latestHealth = healthRecords[0] ?? null;
  const today = fmtReiwa(format(new Date(), "yyyy-MM-dd"));

  const ADL_ITEMS: { key: keyof AdlRecord; label: string; maxScore: number }[] = [
    { key: "eating", label: "食事", maxScore: 10 },
    { key: "transfer", label: "移乗", maxScore: 15 },
    { key: "grooming", label: "整容", maxScore: 5 },
    { key: "toilet", label: "トイレ動作", maxScore: 10 },
    { key: "bathing", label: "入浴", maxScore: 5 },
    { key: "mobility", label: "移動", maxScore: 15 },
    { key: "stairs", label: "階段", maxScore: 10 },
    { key: "dressing", label: "更衣", maxScore: 10 },
    { key: "bowel", label: "排便管理", maxScore: 10 },
    { key: "bladder", label: "排尿管理", maxScore: 10 },
  ];

  return (
    <div style={{ fontFamily: '"MS Mincho", "游明朝", "Hiragino Mincho ProN", serif', fontSize: "9pt", color: "#000" }}>
      {/* Title */}
      <div style={{ textAlign: "center", marginBottom: "4px" }}>
        <div style={{ fontSize: "13pt", fontWeight: "bold", letterSpacing: "0.2em" }}>フェースシート（様式例）</div>
        <div style={{ fontSize: "8pt", textAlign: "right" }}>作成日：{today}</div>
      </div>

      {/* Section 1: 基本情報 */}
      <div style={{ marginBottom: "6px" }}>
        <div style={{ backgroundColor: "#000", color: "#fff", padding: "1px 4px", fontSize: "9pt", fontWeight: "bold" }}>
          第１　基本情報
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: "18%" }} />
            <col style={{ width: "32%" }} />
            <col style={{ width: "18%" }} />
            <col style={{ width: "32%" }} />
          </colgroup>
          <tbody>
            <tr>
              <TH>氏名（漢字）</TH>
              <TD className="px-1 py-0.5 font-bold" style={{ fontSize: "10pt" }}>{user.name}</TD>
              <TH>氏名（ふりがな）</TH>
              <TD className="px-1 py-0.5">{user.name_kana}</TD>
            </tr>
            <tr>
              <TH>性別</TH>
              <TD className="px-1 py-0.5">{user.gender}</TD>
              <TH>生年月日</TH>
              <TD className="px-1 py-0.5">{fmtReiwa(user.birth_date)}　（{calcAge(user.birth_date)}）</TD>
            </tr>
            <tr>
              <TH>住所</TH>
              <TD colSpan={3} className="px-1 py-0.5">
                {user.postal_code ? `〒${user.postal_code}　` : ""}{user.address ?? "　"}
              </TD>
            </tr>
            <tr>
              <TH>電話番号</TH>
              <TD className="px-1 py-0.5">{user.phone ?? "　"}</TD>
              <TH>携帯電話</TH>
              <TD className="px-1 py-0.5">{user.mobile_phone ?? "　"}</TD>
            </tr>
            <tr>
              <TH>被保険者番号</TH>
              <TD className="px-1 py-0.5">{cert?.insured_number ?? "　"}</TD>
              <TH>保険者番号</TH>
              <TD className="px-1 py-0.5">{cert?.insurer_number ?? "　"}</TD>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Section 2: 家族構成 */}
      <div style={{ marginBottom: "6px" }}>
        <div style={{ backgroundColor: "#000", color: "#fff", padding: "1px 4px", fontSize: "9pt", fontWeight: "bold" }}>
          第２　家族構成・キーパーソン
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <TH style={{ width: "20%" }}>氏名</TH>
              <TH style={{ width: "12%" }}>続柄</TH>
              <TH style={{ width: "35%" }}>住所</TH>
              <TH style={{ width: "20%" }}>電話番号</TH>
              <TH style={{ width: "13%" }}>キーパーソン</TH>
            </tr>
          </thead>
          <tbody>
            {contacts.length > 0 ? contacts.map((c) => (
              <tr key={c.id} style={{ height: "18px" }}>
                <TD className="px-1">{c.name}</TD>
                <TD className="px-1 text-center">{c.relationship}</TD>
                <TD className="px-1">{c.address ?? "　"}</TD>
                <TD className="px-1">{c.phone ?? "　"}</TD>
                <TD className="px-1 text-center">{c.is_key_person ? "◎" : "　"}</TD>
              </tr>
            )) : (
              <>
                {[0, 1, 2].map((i) => (
                  <tr key={i} style={{ height: "18px" }}>
                    <TD /><TD /><TD /><TD /><TD />
                  </tr>
                ))}
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* Section 3: 介護認定情報 */}
      <div style={{ marginBottom: "6px" }}>
        <div style={{ backgroundColor: "#000", color: "#fff", padding: "1px 4px", fontSize: "9pt", fontWeight: "bold" }}>
          第３　介護認定情報
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: "18%" }} />
            <col style={{ width: "32%" }} />
            <col style={{ width: "18%" }} />
            <col style={{ width: "32%" }} />
          </colgroup>
          <tbody>
            <tr>
              <TH>要介護状態区分</TH>
              <TD className="px-1 py-0.5">{cert?.care_level ?? "　"}</TD>
              <TH>認定番号</TH>
              <TD className="px-1 py-0.5">{cert?.certification_number ?? "　"}</TD>
            </tr>
            <tr>
              <TH>認定有効期間</TH>
              <TD colSpan={3} className="px-1 py-0.5">
                {cert ? `${fmtReiwa(cert.start_date)}　〜　${fmtReiwa(cert.end_date)}` : "　"}
              </TD>
            </tr>
            <tr>
              <TH>支給限度基準額</TH>
              <TD colSpan={3} className="px-1 py-0.5">
                {cert?.support_limit_amount != null ? `${cert.support_limit_amount.toLocaleString()}単位 / 月` : "　"}
              </TD>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Section 4: 既往歴 */}
      <div style={{ marginBottom: "6px" }}>
        <div style={{ backgroundColor: "#000", color: "#fff", padding: "1px 4px", fontSize: "9pt", fontWeight: "bold" }}>
          第４　既往歴・現病歴
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <TH style={{ width: "28%" }}>疾患名</TH>
              <TH style={{ width: "18%" }}>発症時期</TH>
              <TH style={{ width: "14%" }}>現在の状況</TH>
              <TH style={{ width: "25%" }}>医療機関名</TH>
              <TH style={{ width: "15%" }}>担当医師</TH>
            </tr>
          </thead>
          <tbody>
            {histories.length > 0 ? histories.map((h) => (
              <tr key={h.id} style={{ height: "18px" }}>
                <TD className="px-1">{h.disease_name}</TD>
                <TD className="px-1 text-center">{h.onset_date ? fmtReiwa(h.onset_date) : "不明"}</TD>
                <TD className="px-1 text-center">{h.status}</TD>
                <TD className="px-1">{h.hospital ?? "　"}</TD>
                <TD className="px-1">{h.doctor ?? "　"}</TD>
              </tr>
            )) : (
              <>
                {[0, 1, 2].map((i) => (
                  <tr key={i} style={{ height: "18px" }}>
                    <TD /><TD /><TD /><TD /><TD />
                  </tr>
                ))}
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* Section 5: ADL（バーセルインデックス） */}
      <div style={{ marginBottom: "6px" }}>
        <div style={{ backgroundColor: "#000", color: "#fff", padding: "1px 4px", fontSize: "9pt", fontWeight: "bold" }}>
          第５　ADL状況（バーセルインデックス）
        </div>
        {adl ? (
          <>
            <div style={{ fontSize: "8pt", padding: "1px 2px", borderLeft: "1px solid #000", borderRight: "1px solid #000", borderTop: "1px solid #000" }}>
              評価日：{fmtReiwa(adl.assessment_date)}　／　評価者：{adl.assessor_name ?? "　"}
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {ADL_ITEMS.map((item) => (
                    <TH key={item.key} style={{ width: `${100 / (ADL_ITEMS.length + 1)}%` }}>
                      {item.label}
                      <br />
                      <span style={{ fontSize: "7pt" }}>（{item.maxScore}点）</span>
                    </TH>
                  ))}
                  <TH style={{ backgroundColor: "#333", color: "#fff" }}>合計<br /><span style={{ fontSize: "7pt" }}>（100点）</span></TH>
                </tr>
              </thead>
              <tbody>
                <tr>
                  {ADL_ITEMS.map((item) => (
                    <TD key={item.key} className="text-center py-1 font-bold">{String(adl[item.key])}</TD>
                  ))}
                  <TD className="text-center py-1 font-bold" style={{ backgroundColor: "#f0f0f0" }}>{adl.total_score}</TD>
                </tr>
              </tbody>
            </table>
          </>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {ADL_ITEMS.map((item) => (
                  <TH key={item.key}>{item.label}<br /><span style={{ fontSize: "7pt" }}>（{item.maxScore}点）</span></TH>
                ))}
                <TH>合計</TH>
              </tr>
            </thead>
            <tbody>
              <tr style={{ height: "22px" }}>
                {ADL_ITEMS.map((item) => <TD key={item.key} />)}
                <TD />
              </tr>
            </tbody>
          </table>
        )}
      </div>

      {/* Section 6: 健康状態 */}
      <div style={{ marginBottom: "6px" }}>
        <div style={{ backgroundColor: "#000", color: "#fff", padding: "1px 4px", fontSize: "9pt", fontWeight: "bold" }}>
          第６　健康状態（直近のバイタル）
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: "12%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "13%" }} />
            <col style={{ width: "18%" }} />
            <col style={{ width: "11%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "11%" }} />
            <col style={{ width: "10%" }} />
            <col style={{ width: "7%" }} />
          </colgroup>
          <thead>
            <tr>
              <TH>測定日</TH>
              <TH>体温（℃）</TH>
              <TH>脈拍（回/分）</TH>
              <TH>血圧（mmHg）</TH>
              <TH>SpO2（%）</TH>
              <TH>体重（kg）</TH>
              <TH>身長（cm）</TH>
              <TH>BMI</TH>
            </tr>
          </thead>
          <tbody>
            <tr style={{ height: "22px" }}>
              <TD className="px-1 text-center">{latestHealth ? fmtReiwa(latestHealth.record_date) : "　"}</TD>
              <TD className="px-1 text-center">{latestHealth?.temperature ?? "　"}</TD>
              <TD className="px-1 text-center">{latestHealth?.pulse ?? "　"}</TD>
              <TD className="px-1 text-center">
                {latestHealth?.blood_pressure_sys != null
                  ? `${latestHealth.blood_pressure_sys} / ${latestHealth.blood_pressure_dia ?? "—"}`
                  : "　"}
              </TD>
              <TD className="px-1 text-center">{latestHealth?.spo2 ?? "　"}</TD>
              <TD className="px-1 text-center">{latestHealth?.weight ?? "　"}</TD>
              <TD className="px-1 text-center">{latestHealth?.height ?? "　"}</TD>
              <TD className="px-1 text-center">
                {latestHealth?.weight != null && latestHealth?.height != null && latestHealth.height > 0
                  ? (latestHealth.weight / Math.pow(latestHealth.height / 100, 2)).toFixed(1)
                  : "　"}
              </TD>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Section 7: 特記事項 */}
      <div>
        <div style={{ backgroundColor: "#000", color: "#fff", padding: "1px 4px", fontSize: "9pt", fontWeight: "bold" }}>
          第７　特記事項
        </div>
        <div style={{ border: "1px solid #000", minHeight: "40px", padding: "2px 4px", fontSize: "9pt", whiteSpace: "pre-wrap" }}>
          {user.notes ?? "　"}
        </div>
      </div>

      {/* Signature row */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "6px" }}>
        <tbody>
          <tr>
            <TH style={{ width: "20%" }}>作成者氏名</TH>
            <TD style={{ width: "30%" }} className="px-2" />
            <TH style={{ width: "20%" }}>所属・事業所名</TH>
            <TD style={{ width: "30%" }} className="px-2" />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. 居宅サービス計画書（第1表）
// ---------------------------------------------------------------------------

function CarePlan1Report({
  user,
  cert,
  plan,
}: {
  user: KaigoUser;
  cert: CareCertification | null;
  plan: CarePlan | null;
}) {
  const today = format(new Date(), "yyyy-MM-dd");

  return (
    <div style={{ fontFamily: '"MS Mincho", "游明朝", "Hiragino Mincho ProN", serif', fontSize: "9pt", color: "#000" }}>
      {/* Title */}
      <div style={{ textAlign: "center", marginBottom: "4px" }}>
        <div style={{ fontSize: "12pt", fontWeight: "bold", letterSpacing: "0.2em" }}>
          居宅サービス計画書（1）
        </div>
      </div>

      {/* Row 1: 初回・紹介・継続 / 認定済・申請中 */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "2px" }}>
        <tbody>
          <tr style={{ height: "20px" }}>
            <TH style={{ width: "18%" }}>初回・紹介・継続</TH>
            <TD style={{ width: "37%" }} className="px-2">
              <span style={{ marginRight: "12px" }}>□ 初回</span>
              <span style={{ marginRight: "12px" }}>□ 紹介</span>
              <span>□ 継続</span>
            </TD>
            <TH style={{ width: "18%" }}>認定済・申請中</TH>
            <TD style={{ width: "27%" }} className="px-2">
              <span style={{ marginRight: "12px" }}>□ 認定済</span>
              <span>□ 申請中</span>
            </TD>
          </tr>
        </tbody>
      </table>

      {/* Main user/CM table */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "2px" }}>
        <colgroup>
          <col style={{ width: "22%" }} />
          <col style={{ width: "28%" }} />
          <col style={{ width: "22%" }} />
          <col style={{ width: "28%" }} />
        </colgroup>
        <tbody>
          <tr style={{ height: "22px" }}>
            <TH>利用者名</TH>
            <TD className="px-1 font-bold">{user.name}　様</TD>
            <TH>居宅サービス計画作成者氏名</TH>
            <TD className="px-1" />
          </tr>
          <tr style={{ height: "22px" }}>
            <TH>生年月日</TH>
            <TD className="px-1">{fmtReiwa(user.birth_date)}　({calcAge(user.birth_date)})</TD>
            <TH>居宅介護支援事業者・事業所名及び所在地</TH>
            <TD className="px-1" rowSpan={2} />
          </tr>
          <tr style={{ height: "22px" }}>
            <TH>住所</TH>
            <TD className="px-1">
              {user.postal_code ? `〒${user.postal_code}` : ""} {user.address ?? "　"}
            </TD>
          </tr>
          <tr style={{ height: "22px" }}>
            <TH>居宅サービス計画作成（変更）日</TH>
            <TD className="px-1">{fmtReiwa(plan?.start_date ?? today)}</TD>
            <TH>初回居宅サービス計画作成日</TH>
            <TD className="px-1">{fmtReiwa(plan?.start_date ?? null)}</TD>
          </tr>
          <tr style={{ height: "22px" }}>
            <TH>認定日</TH>
            <TD className="px-1">{fmtReiwa(cert?.start_date ?? null)}</TD>
            <TH>認定の有効期間</TH>
            <TD className="px-1">
              {cert ? `${fmtReiwa(cert.start_date)}　〜　${fmtReiwa(cert.end_date)}` : "　"}
            </TD>
          </tr>
          <tr style={{ height: "22px" }}>
            <TH>要介護状態区分</TH>
            <TD colSpan={3} className="px-2">
              {CARE_LEVELS.map((level) => (
                <span key={level} style={{ marginRight: "8px" }}>
                  {cert?.care_level === level ? "☑" : "□"}　{level}
                </span>
              ))}
            </TD>
          </tr>
        </tbody>
      </table>

      {/* 利用者及び家族の生活に対する意向 */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "2px" }}>
        <tbody>
          <tr>
            <TH style={{ width: "30%", writingMode: "horizontal-tb", padding: "2px 4px" }}>
              利用者及び家族の生活に対する意向を踏まえた課題分析の結果
            </TH>
            <TD style={{ width: "70%", minHeight: "50px", height: "60px", verticalAlign: "top", padding: "4px" }}>
              {plan?.long_term_goals ?? "　"}
            </TD>
          </tr>
        </tbody>
      </table>

      {/* 介護認定審査会の意見 */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "2px" }}>
        <tbody>
          <tr>
            <TH style={{ width: "30%", padding: "2px 4px" }}>
              介護認定審査会の意見及びサービスの種類の指定
            </TH>
            <TD style={{ width: "70%", height: "40px", verticalAlign: "top", padding: "4px" }}>

            </TD>
          </tr>
        </tbody>
      </table>

      {/* 総合的な援助の方針 */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "2px" }}>
        <tbody>
          <tr>
            <TH style={{ width: "30%", padding: "2px 4px" }}>
              総合的な援助の方針
            </TH>
            <TD style={{ width: "70%", height: "60px", verticalAlign: "top", padding: "4px", whiteSpace: "pre-wrap" }}>
              {plan?.short_term_goals ?? "　"}
            </TD>
          </tr>
        </tbody>
      </table>

      {/* 生活援助中心型の算定理由 */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "6px" }}>
        <tbody>
          <tr style={{ height: "22px" }}>
            <TH style={{ width: "30%", padding: "2px 4px" }}>
              生活援助中心型の算定理由
            </TH>
            <TD style={{ width: "70%" }} className="px-3">
              <span style={{ marginRight: "16px" }}>□ 1．一人暮らし</span>
              <span style={{ marginRight: "16px" }}>□ 2．家族等が障害・疾病等</span>
              <span>□ 3．その他（　　　　　　　　　　　　　　　　　）</span>
            </TD>
          </tr>
        </tbody>
      </table>

      {/* Signature / agreement section */}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          <tr style={{ height: "24px" }}>
            <TH style={{ width: "15%" }}>介護支援専門員氏名</TH>
            <TD style={{ width: "35%" }} className="px-2" />
            <TH style={{ width: "15%" }}>事業所番号</TH>
            <TD style={{ width: "35%" }} className="px-2">{cert?.insurer_number ?? "　"}</TD>
          </tr>
          <tr style={{ height: "28px" }}>
            <TH>利用者同意署名</TH>
            <TD className="px-2" />
            <TH>家族等署名</TH>
            <TD className="px-2" />
          </tr>
          <tr style={{ height: "20px" }}>
            <TH>同意年月日</TH>
            <TD colSpan={3} className="px-2">
              {fmtReiwa(today)}
            </TD>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. 居宅サービス計画書（第2表）- landscape
// ---------------------------------------------------------------------------

function CarePlan2Report({
  user,
  cert,
  plan,
  services,
}: {
  user: KaigoUser;
  cert: CareCertification | null;
  plan: CarePlan | null;
  services: CarePlanService[];
}) {
  return (
    <div style={{ fontFamily: '"MS Mincho", "游明朝", "Hiragino Mincho ProN", serif', fontSize: "8pt", color: "#000" }}>
      {/* Title */}
      <div style={{ textAlign: "center", marginBottom: "4px" }}>
        <div style={{ fontSize: "11pt", fontWeight: "bold", letterSpacing: "0.2em" }}>
          居宅サービス計画書（2）
        </div>
      </div>

      {/* Header info */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "3px" }}>
        <tbody>
          <tr style={{ height: "20px" }}>
            <TH style={{ width: "10%" }}>利用者名</TH>
            <TD style={{ width: "20%" }} className="px-1 font-bold">{user.name}　様</TD>
            <TH style={{ width: "12%" }}>要介護度</TH>
            <TD style={{ width: "18%" }} className="px-1">{cert?.care_level ?? "　"}</TD>
            <TH style={{ width: "12%" }}>計画作成日</TH>
            <TD style={{ width: "28%" }} className="px-1">
              {fmtReiwa(plan?.start_date ?? null)}
            </TD>
          </tr>
        </tbody>
      </table>

      {/* Main care plan table */}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ height: "28px" }}>
            <TH style={{ width: "14%" }} rowSpan={2}>
              生活全般の解決す<br />べき課題（ニーズ）
            </TH>
            <TH colSpan={4}>目標</TH>
            <TH colSpan={5}>援助内容</TH>
          </tr>
          <tr style={{ height: "24px" }}>
            <TH style={{ width: "10%" }}>長期目標</TH>
            <TH style={{ width: "5%" }}>（期間）</TH>
            <TH style={{ width: "10%" }}>短期目標</TH>
            <TH style={{ width: "5%" }}>（期間）</TH>
            <TH style={{ width: "16%" }}>サービス内容</TH>
            <TH style={{ width: "3%" }}>※1</TH>
            <TH style={{ width: "10%" }}>サービス種別</TH>
            <TH style={{ width: "3%" }}>※2</TH>
            <TH style={{ width: "5%" }}>頻度</TH>
            <TH style={{ width: "5%" }}>期間</TH>
          </tr>
        </thead>
        <tbody>
          {services.length > 0 ? (
            services.map((svc, i) => (
              <tr key={svc.id || i} style={{ minHeight: "28px" }}>
                {i === 0 ? (
                  <TD rowSpan={services.length} className="px-1 align-top" style={{ verticalAlign: "top", whiteSpace: "pre-wrap" }}>
                    {plan?.long_term_goals ?? "　"}
                  </TD>
                ) : null}
                {i === 0 ? (
                  <TD rowSpan={services.length} className="px-1 align-top" style={{ verticalAlign: "top", whiteSpace: "pre-wrap" }}>
                    {plan?.long_term_goals ?? "　"}
                  </TD>
                ) : null}
                {i === 0 ? (
                  <TD rowSpan={services.length} className="px-1 align-top" style={{ verticalAlign: "top", fontSize: "7pt" }}>
                    {plan?.start_date && plan?.end_date
                      ? `${fmtReiwa(plan.start_date)}〜${fmtReiwa(plan.end_date)}`
                      : "　"}
                  </TD>
                ) : null}
                {i === 0 ? (
                  <TD rowSpan={services.length} className="px-1 align-top" style={{ verticalAlign: "top", whiteSpace: "pre-wrap" }}>
                    {plan?.short_term_goals ?? "　"}
                  </TD>
                ) : null}
                {i === 0 ? (
                  <TD rowSpan={services.length} className="px-1 align-top" style={{ verticalAlign: "top", fontSize: "7pt" }}>
                    {plan?.start_date && plan?.end_date
                      ? `${fmtReiwa(plan.start_date)}〜${fmtReiwa(plan.end_date)}`
                      : "　"}
                  </TD>
                ) : null}
                <TD className="px-1" style={{ verticalAlign: "top" }}>{svc.service_content}</TD>
                <TD className="px-1 text-center" style={{ verticalAlign: "top" }}>○</TD>
                <TD className="px-1 text-center" style={{ verticalAlign: "top" }}>{svc.service_type}</TD>
                <TD className="px-1 text-center" style={{ verticalAlign: "top", fontSize: "7pt" }}>{svc.provider ?? "　"}</TD>
                <TD className="px-1 text-center" style={{ verticalAlign: "top" }}>{svc.frequency ?? "　"}</TD>
                <TD className="px-1 text-center" style={{ verticalAlign: "top", fontSize: "7pt" }}>
                  {plan?.start_date && plan?.end_date
                    ? `${fmtReiwa(plan.start_date)}〜${fmtReiwa(plan.end_date)}`
                    : "　"}
                </TD>
              </tr>
            ))
          ) : (
            // Empty rows
            Array.from({ length: 6 }).map((_, i) => (
              <tr key={i} style={{ height: "28px" }}>
                {i === 0 ? <TD rowSpan={6} /> : null}
                {i === 0 ? <TD rowSpan={6} /> : null}
                {i === 0 ? <TD rowSpan={6} /> : null}
                {i === 0 ? <TD rowSpan={6} /> : null}
                {i === 0 ? <TD rowSpan={6} /> : null}
                <TD /><TD /><TD /><TD /><TD /><TD />
              </tr>
            ))
          )}
        </tbody>
      </table>

      {/* Signature */}
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

// ---------------------------------------------------------------------------
// 4. 週間サービス計画表（第3表）- landscape
// ---------------------------------------------------------------------------

const TIME_SLOTS = [
  { label: "深夜・早朝", range: "0:00〜6:00" },
  { label: "午前", range: "6:00〜12:00" },
  { label: "午後", range: "12:00〜18:00" },
  { label: "夜間", range: "18:00〜21:00" },
  { label: "深夜", range: "21:00〜24:00" },
];

const DAYS_JA = ["月", "火", "水", "木", "金", "土", "日"];

function CarePlan3Report({
  user,
  cert,
  plan,
  services,
}: {
  user: KaigoUser;
  cert: CareCertification | null;
  plan: CarePlan | null;
  services: CarePlanService[];
}) {
  // Map services to days/times for display
  // service_type used as a simple lookup

  return (
    <div style={{ fontFamily: '"MS Mincho", "游明朝", "Hiragino Mincho ProN", serif', fontSize: "8pt", color: "#000" }}>
      {/* Title */}
      <div style={{ textAlign: "center", marginBottom: "4px" }}>
        <div style={{ fontSize: "11pt", fontWeight: "bold", letterSpacing: "0.2em" }}>
          週間サービス計画表
        </div>
      </div>

      {/* Header */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "3px" }}>
        <tbody>
          <tr style={{ height: "20px" }}>
            <TH style={{ width: "10%" }}>利用者名</TH>
            <TD style={{ width: "20%" }} className="px-1 font-bold">{user.name}　様</TD>
            <TH style={{ width: "12%" }}>要介護度</TH>
            <TD style={{ width: "12%" }} className="px-1">{cert?.care_level ?? "　"}</TD>
            <TH style={{ width: "14%" }}>計画期間</TH>
            <TD style={{ width: "32%" }} className="px-1">
              {plan ? `${fmtReiwa(plan.start_date)}　〜　${fmtReiwa(plan.end_date)}` : "　"}
            </TD>
          </tr>
        </tbody>
      </table>

      {/* Weekly schedule table */}
      <table style={{ width: "82%", borderCollapse: "collapse", display: "inline-table", verticalAlign: "top" }}>
        <thead>
          <tr style={{ height: "20px" }}>
            <TH style={{ width: "10%" }}>時間帯</TH>
            {DAYS_JA.map((d) => (
              <TH key={d} style={{ width: `${90 / 7}%` }}>{d}</TH>
            ))}
          </tr>
        </thead>
        <tbody>
          {TIME_SLOTS.map((slot) => (
            <tr key={slot.range} style={{ height: "36px" }}>
              <TD className="text-center" style={{ verticalAlign: "middle", fontSize: "7pt" }}>
                <div style={{ fontWeight: "bold" }}>{slot.label}</div>
                <div style={{ color: "#555" }}>{slot.range}</div>
              </TD>
              {DAYS_JA.map((day) => {
                // Find services that might apply
                const daySvcs = services.filter((s) => {
                  if (!s.frequency) return false;
                  return s.frequency.includes(day) || s.frequency.includes("毎日") || s.frequency.includes("週");
                });
                return (
                  <TD key={day} className="px-0.5" style={{ verticalAlign: "top", fontSize: "7pt" }}>
                    {daySvcs.length > 0 && slot.label === "午前" ? (
                      daySvcs.map((s, i) => (
                        <div key={i} style={{ backgroundColor: "#e8f4f8", border: "1px solid #aaa", padding: "1px 2px", marginBottom: "1px", borderRadius: "2px", fontSize: "7pt" }}>
                          {s.service_content}
                        </div>
                      ))
                    ) : null}
                  </TD>
                );
              })}
            </tr>
          ))}
          {/* 主な日常生活上の活動 */}
          <tr style={{ height: "36px" }}>
            <TD className="text-center" style={{ verticalAlign: "middle", fontSize: "7pt", fontWeight: "bold" }}>
              主な日常<br />生活上の<br />活動
            </TD>
            <TD colSpan={7} className="px-2" style={{ verticalAlign: "top", fontSize: "7pt" }}>
              起床・洗面・着替え　／　食事（朝・昼・夕）　／　レクリエーション　／　入浴　／　就寝
            </TD>
          </tr>
        </tbody>
      </table>

      {/* 週単位以外のサービス - right margin */}
      <table style={{ width: "17%", borderCollapse: "collapse", display: "inline-table", verticalAlign: "top", marginLeft: "1%" }}>
        <thead>
          <tr style={{ height: "20px" }}>
            <TH>週単位以外のサービス</TH>
          </tr>
        </thead>
        <tbody>
          {services
            .filter((s) => s.frequency && (s.frequency.includes("月") || s.frequency.includes("隔月") || s.frequency.includes("年")))
            .map((s, i) => (
              <tr key={i} style={{ height: "28px" }}>
                <TD className="px-1" style={{ fontSize: "7pt", verticalAlign: "top" }}>
                  <div style={{ fontWeight: "bold" }}>{s.service_type}</div>
                  <div>{s.service_content}</div>
                  <div style={{ color: "#555" }}>{s.frequency}</div>
                </TD>
              </tr>
            ))}
          {Array.from({ length: Math.max(4, 4) }).map((_, i) => (
            <tr key={`empty-${i}`} style={{ height: "28px" }}>
              <TD />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. サービス利用票（様式第6）- landscape
// ---------------------------------------------------------------------------

const SLOTS = 9; // always render exactly 9 service rows (予定+実績 pairs = 18 rows)
const DOW_JA = ["日", "月", "火", "水", "木", "金", "土"];

function ServiceUsageReport({
  user,
  cert,
  planServices,
  records,
  yearMonth,
}: {
  user: KaigoUser;
  cert: CareCertification | null;
  planServices: CarePlanService[];
  records: ServiceRecord[];
  yearMonth: string;
}) {
  const monthDate = parseISO(`${yearMonth}-01`);
  const daysInMonth = getDaysInMonth(monthDate);
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  // planned days per service index (from planServices order)
  // actual days per service_type (from serviceRecords)
  const plannedDaysByIdx: Map<number, Set<number>> = new Map();
  // For the 第6表, planned days come from the plan frequency. Since we don't
  // have explicit planned dates, we mark days from service records as 予定.
  // Actual (実績) marks are shown with a filled circle when the record exists.
  const actualDaysByType: Record<string, Set<number>> = {};
  for (const r of records) {
    const day = parseInt(r.service_date.split("-")[2], 10);
    if (!actualDaysByType[r.service_type]) actualDaysByType[r.service_type] = new Set();
    actualDaysByType[r.service_type].add(day);
  }

  // Build planned days per slot index using planServices order
  planServices.forEach((svc, idx) => {
    plannedDaysByIdx.set(idx, actualDaysByType[svc.service_type] ?? new Set());
  });

  const today = fmtReiwa(format(new Date(), "yyyy-MM-dd"));

  // Pad planServices to exactly SLOTS entries
  const slots = Array.from({ length: SLOTS }, (_, i) => planServices[i] ?? null);

  // Calendar column width: squeeze to fit 31 days + label cols + total col
  // Label cols: 提供時間帯(8%), サービス内容(10%), 事業所名(11%) = 29%
  // 合計回数: 4%  => calendar area = 67% over 31 cols ≈ 2.16% each
  const calColW = `${(67 / 31).toFixed(2)}%`;

  return (
    <div style={{ fontFamily: '"MS Mincho", "游明朝", "Hiragino Mincho ProN", serif', fontSize: "7pt", color: "#000" }}>
      {/* ── top: checkbox + title ── */}
      <div style={{ display: "flex", alignItems: "baseline", marginBottom: "2px" }}>
        <span style={{ fontSize: "6.5pt", marginRight: "8px" }}>
          □ 認定済　□ 申請中
        </span>
        <span style={{ flex: 1, textAlign: "center", fontSize: "10pt", fontWeight: "bold", letterSpacing: "0.1em" }}>
          {fmtReiwaMonth(yearMonth)}&nbsp; サービス利用票
        </span>
        <span style={{ fontSize: "6.5pt" }}>居宅介護支援事業所→利用者</span>
      </div>

      {/* ── Header block (3 rows) ── */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "2px", tableLayout: "fixed" }}>
        <colgroup>
          {/* col widths: 保険者番号 label, value, 保険者名 label+val, 事業者名+担当者 label+val, 作成年月日 label+val, 利用者確認 label+val */}
          <col style={{ width: "7%" }} />
          <col style={{ width: "10%" }} />
          <col style={{ width: "6%" }} />
          <col style={{ width: "13%" }} />
          <col style={{ width: "20%" }} />
          <col style={{ width: "14%" }} />
          <col style={{ width: "8%" }} />
          <col style={{ width: "10%" }} />
          <col style={{ width: "6%" }} />
          <col style={{ width: "6%" }} />
        </colgroup>
        <tbody>
          {/* Row 1 */}
          <tr style={{ height: "18px" }}>
            <th style={{ border: "1px solid #000", backgroundColor: "#e8e8e8", fontSize: "6.5pt", textAlign: "center", padding: "1px" }}>保険者番号</th>
            <td style={{ border: "1px solid #000", fontSize: "7pt", padding: "1px 3px", letterSpacing: "0.1em" }}>{cert?.insurer_number ?? ""}</td>
            <th style={{ border: "1px solid #000", backgroundColor: "#e8e8e8", fontSize: "6.5pt", textAlign: "center", padding: "1px" }}>保険者名</th>
            <td style={{ border: "1px solid #000", fontSize: "7pt", padding: "1px 3px" }}></td>
            <th style={{ border: "1px solid #000", backgroundColor: "#e8e8e8", fontSize: "6.5pt", textAlign: "center", padding: "1px" }}>居宅介護支援事業者事業所名<br />担当者名</th>
            <td style={{ border: "1px solid #000", fontSize: "7pt", padding: "1px 3px" }}></td>
            <th style={{ border: "1px solid #000", backgroundColor: "#e8e8e8", fontSize: "6.5pt", textAlign: "center", padding: "1px" }}>作成年月日</th>
            <td style={{ border: "1px solid #000", fontSize: "7pt", padding: "1px 3px" }}>{today}</td>
            <th style={{ border: "1px solid #000", backgroundColor: "#e8e8e8", fontSize: "6.5pt", textAlign: "center", padding: "1px" }} colSpan={2}>利用者確認</th>
          </tr>
          {/* Row 2 */}
          <tr style={{ height: "18px" }}>
            <th style={{ border: "1px solid #000", backgroundColor: "#e8e8e8", fontSize: "6.5pt", textAlign: "center", padding: "1px" }}>被保険者番号</th>
            <td style={{ border: "1px solid #000", fontSize: "7pt", padding: "1px 3px", letterSpacing: "0.1em" }}>{cert?.insured_number ?? ""}</td>
            <th style={{ border: "1px solid #000", backgroundColor: "#e8e8e8", fontSize: "6.5pt", textAlign: "center", padding: "1px" }}>フリガナ<br />被保険者氏名</th>
            <td style={{ border: "1px solid #000", fontSize: "7pt", padding: "1px 3px", fontWeight: "bold" }} colSpan={3}>
              <div style={{ fontSize: "6pt", fontWeight: "normal" }}>{user.name_kana}</div>
              <div>{user.name}</div>
            </td>
            <th style={{ border: "1px solid #000", backgroundColor: "#e8e8e8", fontSize: "6.5pt", textAlign: "center", padding: "1px" }}>届出年月日</th>
            <td style={{ border: "1px solid #000", fontSize: "7pt", padding: "1px 3px" }}></td>
            <td style={{ border: "1px solid #000" }} colSpan={2}></td>
          </tr>
          {/* Row 3 */}
          <tr style={{ height: "20px" }}>
            <th style={{ border: "1px solid #000", backgroundColor: "#e8e8e8", fontSize: "6.5pt", textAlign: "center", padding: "1px" }}>生年月日</th>
            <td style={{ border: "1px solid #000", fontSize: "6.5pt", padding: "1px 2px" }}>{fmtReiwa(user.birth_date)}</td>
            <th style={{ border: "1px solid #000", backgroundColor: "#e8e8e8", fontSize: "6.5pt", textAlign: "center", padding: "1px" }}>性別</th>
            <td style={{ border: "1px solid #000", fontSize: "7pt", padding: "1px 3px" }}>{user.gender}</td>
            <th style={{ border: "1px solid #000", backgroundColor: "#e8e8e8", fontSize: "6.5pt", textAlign: "center", padding: "1px" }}>
              要介護状態区分<br /><span style={{ fontSize: "6pt" }}>変更後・要介護状態区分変更日</span>
            </th>
            <td style={{ border: "1px solid #000", fontSize: "7pt", padding: "1px 3px" }}>
              {cert?.care_level ?? ""}
            </td>
            <th style={{ border: "1px solid #000", backgroundColor: "#e8e8e8", fontSize: "6.5pt", textAlign: "center", padding: "1px" }}>
              区分支給限度基準額<br /><span style={{ fontWeight: "normal" }}>___単位/月</span>
            </th>
            <td style={{ border: "1px solid #000", fontSize: "7pt", padding: "1px 3px" }}>
              {cert?.support_limit_amount != null ? `${cert.support_limit_amount.toLocaleString()}` : ""}
            </td>
            <th style={{ border: "1px solid #000", backgroundColor: "#e8e8e8", fontSize: "6pt", textAlign: "center", padding: "1px" }}>
              限度額適用期間<br />から___まで
            </th>
            <td style={{ border: "1px solid #000", fontSize: "6pt", padding: "1px 2px" }}>
              前月までの短期入所<br />利用日数___日
            </td>
          </tr>
        </tbody>
      </table>

      {/* ── Main grid ── */}
      <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
        <colgroup>
          <col style={{ width: "8%" }} />   {/* 提供時間帯 */}
          <col style={{ width: "10%" }} />  {/* サービス内容 */}
          <col style={{ width: "11%" }} />  {/* サービス事業者・事業所名 */}
          {days.map((d) => <col key={d} style={{ width: calColW }} />)}
          <col style={{ width: "4%" }} />   {/* 合計回数 */}
        </colgroup>
        <thead>
          {/* Day number row */}
          <tr style={{ height: "14px" }}>
            <th style={{ border: "1px solid #000", backgroundColor: "#d0d0d0", fontSize: "6pt", textAlign: "center", padding: "1px" }} rowSpan={2}>提供時間帯</th>
            <th style={{ border: "1px solid #000", backgroundColor: "#d0d0d0", fontSize: "6pt", textAlign: "center", padding: "1px" }} rowSpan={2}>サービス内容</th>
            <th style={{ border: "1px solid #000", backgroundColor: "#d0d0d0", fontSize: "6pt", textAlign: "center", padding: "1px" }} rowSpan={2}>サービス事業者<br />事業所名</th>
            {days.map((d) => {
              const dow = getDay(parseISO(`${yearMonth}-${String(d).padStart(2, "0")}`));
              const isWeekend = dow === 0 || dow === 6;
              return (
                <th key={d} style={{
                  border: "1px solid #000",
                  backgroundColor: isWeekend ? "#e8f5e9" : "#d0d0d0",
                  fontSize: "6pt",
                  textAlign: "center",
                  padding: "0",
                }}>
                  {d}
                </th>
              );
            })}
            <th style={{ border: "1px solid #000", backgroundColor: "#d0d0d0", fontSize: "6pt", textAlign: "center", padding: "1px" }} rowSpan={2}>合計<br />回数</th>
          </tr>
          {/* Day-of-week row */}
          <tr style={{ height: "12px" }}>
            {days.map((d) => {
              const dow = getDay(parseISO(`${yearMonth}-${String(d).padStart(2, "0")}`));
              const isWeekend = dow === 0 || dow === 6;
              return (
                <th key={d} style={{
                  border: "1px solid #000",
                  backgroundColor: isWeekend ? "#e8f5e9" : "#d0d0d0",
                  fontSize: "5.5pt",
                  textAlign: "center",
                  padding: "0",
                  color: dow === 0 ? "#cc0000" : dow === 6 ? "#0000cc" : "#000",
                }}>
                  {DOW_JA[dow]}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {slots.map((svc, idx) => {
            const plannedDays = svc ? (plannedDaysByIdx.get(idx) ?? new Set<number>()) : new Set<number>();
            const actualDays = svc ? (actualDaysByType[svc.service_type] ?? new Set<number>()) : new Set<number>();
            const totalCount = actualDays.size > 0 ? actualDays.size : plannedDays.size;

            return (
              <React.Fragment key={idx}>
              {/* 予定 row */}
              <tr style={{ height: "16px" }}>
                <td style={{ border: "1px solid #000", fontSize: "6pt", padding: "1px 2px", textAlign: "center", verticalAlign: "middle" }} rowSpan={2}>
                  {/* 提供時間帯 – blank for user to fill */}
                </td>
                <td style={{ border: "1px solid #000", fontSize: "6pt", padding: "1px 2px", verticalAlign: "middle" }}
                    rowSpan={2}>
                  {svc?.service_content ?? ""}
                </td>
                <td style={{ border: "1px solid #000", fontSize: "6pt", padding: "1px 2px", verticalAlign: "middle" }}
                    rowSpan={2}>
                  {svc?.provider ?? ""}
                </td>
                {days.map((d) => {
                  const dow = getDay(parseISO(`${yearMonth}-${String(d).padStart(2, "0")}`));
                  const isWeekend = dow === 0 || dow === 6;
                  const marked = svc ? plannedDays.has(d) : false;
                  return (
                    <td key={d} style={{
                      border: "1px dashed #666",
                      backgroundColor: isWeekend ? "#e8f5e9" : "transparent",
                      fontSize: "8pt",
                      textAlign: "center",
                      padding: "0",
                    }}>
                      {marked ? "○" : ""}
                    </td>
                  );
                })}
                <td style={{ border: "1px solid #000", fontSize: "6.5pt", textAlign: "center", verticalAlign: "middle" }}
                    rowSpan={2}>
                  {svc && totalCount > 0 ? totalCount : ""}
                </td>
              </tr>
              {/* 実績 row */}
              <tr style={{ height: "16px" }}>
                {days.map((d) => {
                  const dow = getDay(parseISO(`${yearMonth}-${String(d).padStart(2, "0")}`));
                  const isWeekend = dow === 0 || dow === 6;
                  const marked = svc ? actualDays.has(d) : false;
                  return (
                    <td key={d} style={{
                      border: "1px solid #000",
                      backgroundColor: isWeekend ? "#e8f5e9" : "transparent",
                      fontSize: "8pt",
                      textAlign: "center",
                      padding: "0",
                    }}>
                      {marked ? "●" : ""}
                    </td>
                  );
                })}
              </tr>
              </React.Fragment>
            );
          })}
        </tbody>
      </table>

      {/* ── Bottom spacer for totals/signatures ── */}
      <div style={{ marginTop: "4px", height: "20px", border: "1px solid #000", fontSize: "6.5pt", padding: "2px 4px", color: "#555" }}>
        （給付管理・担当者確認欄）
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 6. サービス提供票（様式第7）- landscape
// ---------------------------------------------------------------------------

function ServiceProvisionReport({
  user,
  cert,
  records,
  yearMonth,
  planServices,
}: {
  user: KaigoUser;
  cert: CareCertification | null;
  records: ServiceRecord[];
  yearMonth: string;
  planServices: CarePlanService[];
}) {
  const monthDate = parseISO(`${yearMonth}-01`);
  const daysInMonth = getDaysInMonth(monthDate);
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  const actualByTypeDay: Record<string, Set<number>> = {};
  for (const r of records) {
    if (!actualByTypeDay[r.service_type]) actualByTypeDay[r.service_type] = new Set();
    const day = parseInt(r.service_date.split("-")[2], 10);
    actualByTypeDay[r.service_type].add(day);
  }

  const planTypes = planServices.map((s) => s.service_type);
  const actualTypes = Object.keys(actualByTypeDay);
  const allTypes = [...new Set([...planTypes, ...actualTypes])];

  return (
    <div style={{ fontFamily: '"MS Mincho", "游明朝", "Hiragino Mincho ProN", serif', fontSize: "7.5pt", color: "#000" }}>
      {/* Title */}
      <div style={{ textAlign: "center", marginBottom: "3px" }}>
        <div style={{ fontSize: "10pt", fontWeight: "bold", letterSpacing: "0.15em" }}>
          サービス提供票
        </div>
      </div>

      {/* Header */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "3px" }}>
        <tbody>
          <tr style={{ height: "18px" }}>
            <TH style={{ width: "10%" }}>保険者番号</TH>
            <TD style={{ width: "12%" }} className="px-1">{cert?.insurer_number ?? "　"}</TD>
            <TH style={{ width: "10%" }}>被保険者番号</TH>
            <TD style={{ width: "12%" }} className="px-1">{cert?.insured_number ?? "　"}</TD>
            <TH style={{ width: "8%" }}>氏名</TH>
            <TD style={{ width: "14%" }} className="px-1 font-bold">{user.name}</TD>
            <TH style={{ width: "10%" }}>要介護度</TH>
            <TD style={{ width: "10%" }} className="px-1">{cert?.care_level ?? "　"}</TD>
            <TH style={{ width: "10%" }}>対象年月</TH>
            <TD style={{ width: "14%" }} className="px-1">{fmtReiwaMonth(yearMonth)}</TD>
          </tr>
        </tbody>
      </table>

      {/* Legend */}
      <div style={{ fontSize: "7pt", marginBottom: "2px", color: "#333" }}>
        ※上段：予定（○）　下段：実績（●）
      </div>

      {/* Main provision table */}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ height: "20px" }}>
            <TH style={{ width: "12%" }} rowSpan={2}>事業所名</TH>
            <TH style={{ width: "10%" }} rowSpan={2}>サービス内容</TH>
            <TH style={{ width: "8%" }} rowSpan={2}>サービス種類</TH>
            {days.map((d) => {
              const dayOfWeek = getDay(parseISO(`${yearMonth}-${String(d).padStart(2, "0")}`));
              const isSun = dayOfWeek === 0;
              const isSat = dayOfWeek === 6;
              return (
                <TH
                  key={d}
                  style={{
                    width: `${62 / daysInMonth}%`,
                    backgroundColor: isSun ? "#ffeeee" : isSat ? "#eeeeff" : "#f0f0f0",
                    color: isSun ? "#cc0000" : isSat ? "#0000cc" : "#000",
                    fontSize: "6.5pt",
                    padding: "1px",
                  }}
                >
                  {d}
                </TH>
              );
            })}
            <TH style={{ width: "4%" }} rowSpan={2}>予定</TH>
            <TH style={{ width: "4%" }} rowSpan={2}>実績</TH>
          </tr>
          <tr style={{ height: "12px" }}>
            {days.map((d) => {
              const dayOfWeek = getDay(parseISO(`${yearMonth}-${String(d).padStart(2, "0")}`));
              const DOW_JA = ["日", "月", "火", "水", "木", "金", "土"];
              const isSun = dayOfWeek === 0;
              const isSat = dayOfWeek === 6;
              return (
                <TH
                  key={d}
                  style={{
                    fontSize: "6pt",
                    backgroundColor: isSun ? "#ffeeee" : isSat ? "#eeeeff" : "#f0f0f0",
                    color: isSun ? "#cc0000" : isSat ? "#0000cc" : "#555",
                    padding: "0px",
                  }}
                >
                  {DOW_JA[dayOfWeek]}
                </TH>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {allTypes.length > 0 ? (
            allTypes.map((svcType) => {
              const planSvc = planServices.find((s) => s.service_type === svcType);
              const actualDays = actualByTypeDay[svcType] ?? new Set<number>();
              const plannedCount = days.filter((d) => {
                // Assume all days in plan are planned if service exists
                return planSvc != null;
              }).length;
              const actualCount = actualDays.size;
              return (
                <tr key={svcType} style={{ height: "24px" }}>
                  <TD className="px-1" style={{ fontSize: "7pt" }}>{planSvc?.provider ?? "　"}</TD>
                  <TD className="px-1" style={{ fontSize: "7pt" }}>{planSvc?.service_content ?? svcType}</TD>
                  <TD className="px-1 text-center" style={{ fontSize: "7pt" }}>{svcType}</TD>
                  {days.map((d) => {
                    const hasActual = actualDays.has(d);
                    const hasPlanned = planSvc != null;
                    return (
                      <TD
                        key={d}
                        style={{
                          padding: "0",
                          verticalAlign: "middle",
                          textAlign: "center",
                          fontSize: "8pt",
                        }}
                      >
                        <div style={{ borderBottom: "1px solid #ccc", lineHeight: "11px", minHeight: "11px", backgroundColor: hasPlanned ? "#f0f8ff" : "transparent" }}>
                          {hasPlanned ? "○" : ""}
                        </div>
                        <div style={{ lineHeight: "11px", minHeight: "11px", backgroundColor: hasActual ? "#fff0f0" : "transparent" }}>
                          {hasActual ? "●" : ""}
                        </div>
                      </TD>
                    );
                  })}
                  <TD className="text-center font-bold" style={{ fontSize: "8pt" }}>{planSvc ? "—" : "　"}</TD>
                  <TD className="text-center font-bold" style={{ fontSize: "8pt" }}>{actualCount > 0 ? actualCount : "　"}</TD>
                </tr>
              );
            })
          ) : (
            Array.from({ length: 5 }).map((_, i) => (
              <tr key={i} style={{ height: "24px" }}>
                <TD /><TD /><TD />
                {days.map((d) => (
                  <TD key={d} style={{ padding: "0" }}>
                    <div style={{ borderBottom: "1px solid #ccc", minHeight: "11px" }} />
                    <div style={{ minHeight: "11px" }} />
                  </TD>
                ))}
                <TD /><TD />
              </tr>
            ))
          )}
        </tbody>
      </table>

      {/* 給付管理 summary */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "4px" }}>
        <tbody>
          <tr style={{ height: "20px" }}>
            <TH style={{ width: "20%" }}>実績サービス日数合計</TH>
            <TD style={{ width: "12%" }} className="px-2 font-bold text-right">
              {Object.values(actualByTypeDay).reduce((s, set) => s + set.size, 0)}　日
            </TD>
            <TH style={{ width: "20%" }}>事業所番号</TH>
            <TD style={{ width: "16%" }} className="px-1">{cert?.insurer_number ?? "　"}</TD>
            <TH style={{ width: "12%" }}>確認印</TH>
            <TD style={{ width: "20%" }} className="px-2" />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 7. 請求書
// ---------------------------------------------------------------------------

function InvoiceReport({
  user,
  billingRecords,
  billingDetails,
  yearMonth,
}: {
  user: KaigoUser;
  billingRecords: BillingRecord[];
  billingDetails: BillingDetail[];
  yearMonth: string;
}) {
  const totalAmount = billingRecords.reduce((s, r) => s + (r.total_amount ?? 0), 0);
  const totalInsurance = billingRecords.reduce((s, r) => s + (r.insurance_amount ?? 0), 0);
  const totalCopay = billingRecords.reduce((s, r) => s + (r.copay_amount ?? 0), 0);

  const detailMap: Record<string, BillingDetail[]> = {};
  for (const d of billingDetails) {
    if (!detailMap[d.billing_record_id]) detailMap[d.billing_record_id] = [];
    detailMap[d.billing_record_id].push(d);
  }

  const today = fmtReiwa(format(new Date(), "yyyy-MM-dd"));

  return (
    <div style={{ fontFamily: '"MS Mincho", "游明朝", "Hiragino Mincho ProN", serif', fontSize: "9pt", color: "#000" }}>
      {/* Title */}
      <div style={{ textAlign: "center", marginBottom: "8px" }}>
        <div style={{ fontSize: "14pt", fontWeight: "bold", letterSpacing: "0.3em" }}>請　求　書</div>
      </div>

      {/* Header: 宛先 & 発行元 */}
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "12px" }}>
        <div style={{ width: "55%" }}>
          <div style={{ fontSize: "11pt", fontWeight: "bold", borderBottom: "2px solid #000", paddingBottom: "2px", marginBottom: "4px" }}>
            {user.name}　様
          </div>
          <div style={{ fontSize: "8pt", color: "#555" }}>
            〒{user.postal_code ?? "　"} {user.address ?? "　"}
          </div>
          <div style={{ marginTop: "8px", border: "1px solid #000", padding: "4px 8px", display: "inline-block" }}>
            <span style={{ fontSize: "9pt" }}>ご請求金額（税込）：</span>
            <span style={{ fontSize: "13pt", fontWeight: "bold" }}>{fmtCurrency(totalCopay)}</span>
          </div>
        </div>
        <div style={{ width: "40%", textAlign: "right", fontSize: "8.5pt" }}>
          <div>発行日：{today}</div>
          <div style={{ marginTop: "4px" }}>対象月：{fmtReiwaMonth(yearMonth)}</div>
          <div style={{ marginTop: "8px", fontWeight: "bold" }}>○○介護支援事業所</div>
          <div>担当：介護支援専門員</div>
        </div>
      </div>

      {/* 請求概要 */}
      <div style={{ marginBottom: "4px", fontWeight: "bold", borderBottom: "1px solid #000", paddingBottom: "2px" }}>
        ■ 介護保険サービス利用料明細
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "8px" }}>
        <thead>
          <tr style={{ backgroundColor: "#e0e0e0", height: "22px" }}>
            <TH style={{ width: "28%" }}>サービス種別</TH>
            <TH style={{ width: "10%" }}>総単位数</TH>
            <TH style={{ width: "10%" }}>単位単価（円）</TH>
            <TH style={{ width: "13%" }}>総費用額（円）</TH>
            <TH style={{ width: "13%" }}>保険給付額（円）</TH>
            <TH style={{ width: "13%" }}>自己負担額（円）</TH>
            <TH style={{ width: "13%" }}>状態</TH>
          </tr>
        </thead>
        <tbody>
          {billingRecords.length === 0 ? (
            <tr style={{ height: "28px" }}>
              <TD colSpan={7} className="text-center" style={{ color: "#888" }}>
                請求データがありません
              </TD>
            </tr>
          ) : (
            billingRecords.map((rec) => (
              <tr key={rec.id} style={{ height: "22px" }}>
                <TD className="px-2">{rec.service_type}</TD>
                <TD className="px-2 text-right">{rec.total_units.toLocaleString()}</TD>
                <TD className="px-2 text-right">{rec.unit_price.toLocaleString()}</TD>
                <TD className="px-2 text-right">{rec.total_amount.toLocaleString()}</TD>
                <TD className="px-2 text-right">{rec.insurance_amount.toLocaleString()}</TD>
                <TD className="px-2 text-right font-bold">{rec.copay_amount.toLocaleString()}</TD>
                <TD className="px-2 text-center">
                  {rec.status === "paid" ? "支払済" : rec.status === "submitted" ? "請求済" : "下書き"}
                </TD>
              </tr>
            ))
          )}
        </tbody>
        {billingRecords.length > 0 && (
          <tfoot>
            <tr style={{ backgroundColor: "#f0f0f0", height: "22px" }}>
              <TD colSpan={3} className="px-2 text-right font-bold">合　計</TD>
              <TD className="px-2 text-right font-bold">{totalAmount.toLocaleString()}</TD>
              <TD className="px-2 text-right font-bold">{totalInsurance.toLocaleString()}</TD>
              <TD className="px-2 text-right font-bold" style={{ backgroundColor: "#fff0f0" }}>
                {totalCopay.toLocaleString()}
              </TD>
              <TD />
            </tr>
          </tfoot>
        )}
      </table>

      {/* 請求明細 */}
      {billingDetails.length > 0 && (
        <>
          <div style={{ marginBottom: "4px", fontWeight: "bold", borderBottom: "1px solid #000", paddingBottom: "2px" }}>
            ■ 請求明細
          </div>
          {billingRecords.map((rec) => {
            const details = detailMap[rec.id] ?? [];
            if (details.length === 0) return null;
            return (
              <div key={rec.id} style={{ marginBottom: "8px" }}>
                <div style={{ backgroundColor: "#e8e8e8", padding: "1px 6px", border: "1px solid #999", fontWeight: "bold", fontSize: "8.5pt" }}>
                  {rec.service_type}
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ height: "18px", backgroundColor: "#f5f5f5" }}>
                      <TH style={{ width: "16%" }}>サービス日</TH>
                      <TH style={{ width: "16%" }}>サービスコード</TH>
                      <TH style={{ width: "44%" }}>サービス名称</TH>
                      <TH style={{ width: "12%" }}>単位数</TH>
                      <TH style={{ width: "12%" }}>金額（円）</TH>
                    </tr>
                  </thead>
                  <tbody>
                    {details.map((d) => (
                      <tr key={d.id} style={{ height: "18px" }}>
                        <TD className="px-1 text-center">{fmtDate(d.service_date)}</TD>
                        <TD className="px-1 text-center" style={{ fontFamily: "monospace" }}>{d.service_code}</TD>
                        <TD className="px-1">{d.service_name}</TD>
                        <TD className="px-1 text-right">{d.units.toLocaleString()}</TD>
                        <TD className="px-1 text-right">{d.amount.toLocaleString()}</TD>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </>
      )}

      {/* お振込み先 */}
      <div style={{ marginTop: "16px", border: "1px solid #999", padding: "6px 12px" }}>
        <div style={{ fontWeight: "bold", marginBottom: "4px", fontSize: "8.5pt" }}>【お振込み先】</div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            <tr style={{ height: "18px" }}>
              <TH style={{ width: "20%" }}>金融機関名</TH>
              <TD className="px-2" style={{ width: "30%" }} />
              <TH style={{ width: "20%" }}>口座番号</TH>
              <TD className="px-2" style={{ width: "30%" }} />
            </tr>
            <tr style={{ height: "18px" }}>
              <TH>口座名義</TH>
              <TD className="px-2" colSpan={3} />
            </tr>
          </tbody>
        </table>
        <div style={{ fontSize: "7.5pt", color: "#555", marginTop: "4px" }}>
          ※ お支払い期限：{today}よりご請求月末　／　ご不明な点はご連絡ください。
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
  const isLandscape = config?.landscape ?? false;

  const supabase = createClient();

  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedYearMonth, setSelectedYearMonth] = useState(
    format(new Date(), "yyyy-MM")
  );
  const [showReport, setShowReport] = useState(false);
  const [userList, setUserList] = useState<{ id: string; name: string }[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Data states
  const [user, setUser] = useState<KaigoUser | null>(null);
  const [cert, setCert] = useState<CareCertification | null>(null);
  const [insurance, setInsurance] = useState<MedicalInsurance | null>(null);
  const [adl, setAdl] = useState<AdlRecord | null>(null);
  const [histories, setHistories] = useState<MedicalHistory[]>([]);
  const [contacts, setContacts] = useState<FamilyContact[]>([]);
  const [healthRecords, setHealthRecords] = useState<HealthRecord[]>([]);
  const [carePlan, setCarePlan] = useState<CarePlan | null>(null);
  const [planServices, setPlanServices] = useState<CarePlanService[]>([]);
  const [serviceRecords, setServiceRecords] = useState<ServiceRecord[]>([]);
  const [billingRecords, setBillingRecords] = useState<BillingRecord[]>([]);
  const [billingDetails, setBillingDetails] = useState<BillingDetail[]>([]);

  // Fetch user list
  useEffect(() => {
    async function load() {
      setUsersLoading(true);
      const { data } = await supabase
        .from("kaigo_users")
        .select("id, name")
        .eq("status", "active")
        .order("name_kana");
      setUserList(data ?? []);
      setUsersLoading(false);
    }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!selectedUserId) return;
    setLoading(true);
    setError(null);
    setShowReport(false);

    try {
      // Always fetch user
      const { data: userData, error: ue } = await supabase
        .from("kaigo_users")
        .select("*")
        .eq("id", selectedUserId)
        .single();
      if (ue) throw ue;
      setUser(userData);

      // Helper to get active cert
      const fetchCert = async () => {
        const { data } = await supabase
          .from("kaigo_care_certifications")
          .select("*")
          .eq("user_id", selectedUserId)
          .eq("status", "active")
          .order("start_date", { ascending: false })
          .limit(1);
        return data?.[0] ?? null;
      };

      // Helper to get active plan
      const fetchPlan = async () => {
        const { data } = await supabase
          .from("kaigo_care_plans")
          .select("*")
          .eq("user_id", selectedUserId)
          .eq("status", "active")
          .order("start_date", { ascending: false })
          .limit(1);
        return data?.[0] ?? null;
      };

      // Helper to get plan services
      const fetchPlanServices = async (planId: string) => {
        const { data } = await supabase
          .from("kaigo_care_plan_services")
          .select("*")
          .eq("care_plan_id", planId)
          .order("service_type");
        return data ?? [];
      };

      if (reportType === "face-sheet") {
        const [certData, insData, adlData, histData, famData, hrData] = await Promise.all([
          fetchCert(),
          supabase
            .from("kaigo_medical_insurances")
            .select("*")
            .eq("user_id", selectedUserId)
            .order("created_at", { ascending: false })
            .limit(1)
            .then(({ data }) => data?.[0] ?? null),
          supabase
            .from("kaigo_adl_records")
            .select("*")
            .eq("user_id", selectedUserId)
            .order("assessment_date", { ascending: false })
            .limit(1)
            .then(({ data }) => data?.[0] ?? null),
          supabase
            .from("kaigo_medical_histories")
            .select("*")
            .eq("user_id", selectedUserId)
            .order("onset_date", { ascending: false })
            .then(({ data }) => data ?? []),
          supabase
            .from("kaigo_family_contacts")
            .select("*")
            .eq("user_id", selectedUserId)
            .order("is_key_person", { ascending: false })
            .then(({ data }) => data ?? []),
          supabase
            .from("kaigo_health_records")
            .select("*")
            .eq("user_id", selectedUserId)
            .order("record_date", { ascending: false })
            .limit(1)
            .then(({ data }) => data ?? []),
        ]);
        setCert(certData);
        setInsurance(insData);
        setAdl(adlData);
        setHistories(histData);
        setContacts(famData);
        setHealthRecords(hrData);
      }

      if (reportType === "care-plan-1") {
        const [certData, planData] = await Promise.all([fetchCert(), fetchPlan()]);
        setCert(certData);
        setCarePlan(planData);
      }

      if (reportType === "care-plan-2" || reportType === "care-plan-3") {
        const certData = await fetchCert();
        setCert(certData);
        const planData = await fetchPlan();
        setCarePlan(planData);
        if (planData) {
          const svcs = await fetchPlanServices(planData.id);
          setPlanServices(svcs);
        } else {
          setPlanServices([]);
        }
      }

      if (reportType === "service-usage" || reportType === "service-provision") {
        const [year, month] = selectedYearMonth.split("-").map(Number);
        const lastDay = getDaysInMonth(new Date(year, month - 1));
        const monthStart = `${selectedYearMonth}-01`;
        const monthEnd = `${selectedYearMonth}-${String(lastDay).padStart(2, "0")}`;

        const [certData, srData] = await Promise.all([
          fetchCert(),
          supabase
            .from("kaigo_service_records")
            .select("*")
            .eq("user_id", selectedUserId)
            .gte("service_date", monthStart)
            .lte("service_date", monthEnd)
            .order("service_date", { ascending: true })
            .then(({ data, error: e }) => {
              if (e) throw e;
              return data ?? [];
            }),
        ]);
        setCert(certData);
        setServiceRecords(srData);

        const planData = await fetchPlan();
        setCarePlan(planData);
        if (planData) {
          const svcs = await fetchPlanServices(planData.id);
          setPlanServices(svcs);
        } else {
          setPlanServices([]);
        }
      }

      if (reportType === "invoice") {
        const [year, month] = selectedYearMonth.split("-").map(Number);
        const lastDay = getDaysInMonth(new Date(year, month - 1));
        const monthStart = `${selectedYearMonth}-01`;
        const monthEnd = `${selectedYearMonth}-${String(lastDay).padStart(2, "0")}`;

        const { data: brData, error: bre } = await supabase
          .from("kaigo_billing_records")
          .select("*")
          .eq("user_id", selectedUserId)
          .gte("billing_month", monthStart)
          .lte("billing_month", monthEnd)
          .order("created_at", { ascending: true });
        if (bre) throw bre;
        setBillingRecords(brData ?? []);

        if (brData && brData.length > 0) {
          const recIds = brData.map((r: BillingRecord) => r.id);
          const { data: bdData, error: bde } = await supabase
            .from("kaigo_billing_details")
            .select("*")
            .in("billing_record_id", recIds)
            .order("service_date", { ascending: true });
          if (bde) throw bde;
          setBillingDetails(bdData ?? []);
        } else {
          setBillingDetails([]);
        }
      }

      setShowReport(true);
    } catch (err: unknown) {
      setError(
        "データの取得に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setLoading(false);
    }
  }, [selectedUserId, selectedYearMonth, reportType, supabase]);

  // Year-month options: current ± 12 months, newest first
  const monthOptions: string[] = [];
  for (let i = -12; i <= 2; i++) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() + i);
    monthOptions.push(format(d, "yyyy-MM"));
  }
  monthOptions.sort((a, b) => b.localeCompare(a));

  const printStyle = isLandscape ? PRINT_STYLE_LANDSCAPE : PRINT_STYLE_PORTRAIT;

  // Paper dimensions for screen preview
  const paperWidth = isLandscape ? "297mm" : "210mm";
  const paperMinHeight = isLandscape ? "210mm" : "297mm";
  const paperPadding = isLandscape ? "8mm 10mm" : "10mm 12mm";

  if (!config) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-gray-500">
        <AlertTriangle size={40} className="mb-3 text-amber-400" />
        <p className="text-lg font-semibold text-gray-700">不明な帳票種別です</p>
        <Link href="/reports" className="mt-4 text-sm text-blue-600 hover:underline">
          帳票一覧に戻る
        </Link>
      </div>
    );
  }

  const handleUserSelect = (userId: string) => {
    setSelectedUserId(userId);
    setShowReport(false);
  };

  return (
    <>
      <style>{printStyle}</style>

      <div className="flex h-full -m-6">
        <UserSidebar selectedUserId={selectedUserId} onSelectUser={handleUserSelect} />
        <div className="flex-1 overflow-y-auto p-6">
      <div className="space-y-6">
        {/* Page Header */}
        <div className="no-print flex items-center gap-4">
          <Link
            href="/reports"
            className="flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <ChevronLeft size={16} />
            帳票一覧
          </Link>
          <div>
            <h1 className="text-xl font-bold text-gray-900">{config.titleJa}</h1>
            <p className="text-xs text-gray-500 mt-0.5">
              公式様式　帳票作成・印刷
              {isLandscape && (
                <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-blue-700">横向き（A4 landscape）</span>
              )}
            </p>
          </div>
        </div>

        {/* Control Panel */}
        <div className="no-print rounded-xl border bg-white p-6 shadow-sm">
          <h2 className="text-sm font-semibold text-gray-700 mb-4 pb-2 border-b">
            帳票条件の設定
          </h2>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            {/* Month select */}
            {config.needsPeriod && (
              <div className="w-52">
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  <CalendarDays size={12} className="inline mr-1" />
                  対象月 <span className="text-red-500">*</span>
                </label>
                <select
                  value={selectedYearMonth}
                  onChange={(e) => {
                    setSelectedYearMonth(e.target.value);
                    setShowReport(false);
                  }}
                  className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  {monthOptions.map((ym) => (
                    <option key={ym} value={ym}>
                      {fmtJaYear(ym + "-01")}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Generate button */}
            <button
              onClick={handleGenerate}
              disabled={!selectedUserId || loading}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              {loading ? (
                <>
                  <Loader2 size={15} className="animate-spin" />
                  生成中...
                </>
              ) : (
                <>
                  <FileText size={15} />
                  帳票を生成
                </>
              )}
            </button>

            {/* Print button */}
            {showReport && (
              <button
                onClick={() => window.print()}
                className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors whitespace-nowrap"
              >
                <Printer size={15} />
                印刷する
              </button>
            )}
          </div>

          {error && (
            <div className="mt-4 flex items-center gap-2 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">
              <AlertTriangle size={16} />
              {error}
            </div>
          )}
        </div>

        {/* Report Preview */}
        {showReport && user && (
          <div>
            <div className="no-print mb-3 flex items-center justify-between">
              <p className="text-sm text-gray-500">
                プレビュー（印刷するとA4{isLandscape ? "横" : "縦"}サイズで出力されます）
              </p>
              <button
                onClick={() => window.print()}
                className="flex items-center gap-2 rounded-lg bg-gray-800 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-900 transition-colors"
              >
                <Printer size={14} />
                印刷
              </button>
            </div>

            {/* A4 paper */}
            <div
              id="print-area"
              className="mx-auto bg-white shadow-md"
              style={{
                width: paperWidth,
                minHeight: paperMinHeight,
                padding: paperPadding,
                fontFamily: '"MS Mincho", "游明朝", "Hiragino Mincho ProN", serif',
                fontSize: "9pt",
                color: "#000",
                boxSizing: "border-box",
                overflowX: isLandscape ? "auto" : "hidden",
              }}
            >
              {reportType === "face-sheet" && (
                <FaceSheetReport
                  user={user}
                  cert={cert}
                  adl={adl}
                  histories={histories}
                  contacts={contacts}
                  healthRecords={healthRecords}
                />
              )}

              {reportType === "care-plan-1" && (
                <CarePlan1Report user={user} cert={cert} plan={carePlan} />
              )}

              {reportType === "care-plan-2" && (
                <CarePlan2Report
                  user={user}
                  cert={cert}
                  plan={carePlan}
                  services={planServices}
                />
              )}

              {reportType === "care-plan-3" && (
                <CarePlan3Report
                  user={user}
                  cert={cert}
                  plan={carePlan}
                  services={planServices}
                />
              )}

              {reportType === "service-usage" && (
                <ServiceUsageReport
                  user={user}
                  cert={cert}
                  planServices={planServices}
                  records={serviceRecords}
                  yearMonth={selectedYearMonth}
                />
              )}

              {reportType === "service-provision" && (
                <ServiceProvisionReport
                  user={user}
                  cert={cert}
                  records={serviceRecords}
                  yearMonth={selectedYearMonth}
                  planServices={planServices}
                />
              )}

              {reportType === "invoice" && (
                <InvoiceReport
                  user={user}
                  billingRecords={billingRecords}
                  billingDetails={billingDetails}
                  yearMonth={selectedYearMonth}
                />
              )}
            </div>
          </div>
        )}

        {/* Empty state */}
        {!showReport && !loading && (
          <div className="no-print flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-gray-50 py-20 text-gray-400">
            <FileText size={40} className="mb-3 opacity-40" />
            <p className="text-sm">
              利用者を選択して「帳票を生成」ボタンを押してください
            </p>
          </div>
        )}
      </div>
        </div>
      </div>
    </>
  );
}
