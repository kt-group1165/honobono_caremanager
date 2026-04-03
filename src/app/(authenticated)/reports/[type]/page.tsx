"use client";

import { useParams } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
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
import {
  format,
  parseISO,
  differenceInYears,
  getDaysInMonth,
  startOfMonth,
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
};

const REPORT_CONFIG: Record<string, ReportConfig> = {
  "face-sheet": { titleJa: "フェースシート", needsPeriod: false },
  "care-plan-1": { titleJa: "居宅サービス計画書（第1表）", needsPeriod: false },
  "care-plan-2": { titleJa: "居宅サービス計画書（第2表）", needsPeriod: false },
  "service-usage": { titleJa: "サービス利用票", needsPeriod: true },
  "service-provision": { titleJa: "サービス提供票", needsPeriod: true },
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

// ---------------------------------------------------------------------------
// Print styles injected via a <style> tag
// ---------------------------------------------------------------------------

const PRINT_STYLE = `
@media print {
  body * { visibility: hidden !important; }
  #print-area, #print-area * { visibility: visible !important; }
  #print-area {
    position: absolute !important;
    inset: 0 !important;
    padding: 10mm 12mm !important;
    font-size: 10pt !important;
    color: #000 !important;
    background: #fff !important;
  }
  .no-print { display: none !important; }
  table { border-collapse: collapse !important; }
  td, th { border: 1px solid #333 !important; }
  @page { size: A4 portrait; margin: 0; }
}
`;

// ---------------------------------------------------------------------------
// TableRow helper for form-style layouts
// ---------------------------------------------------------------------------

function TR({
  label,
  value,
  wide,
}: {
  label: string;
  value: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <tr>
      <td
        className={`border border-gray-400 bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 whitespace-nowrap ${wide ? "w-40" : "w-28"}`}
      >
        {label}
      </td>
      <td className="border border-gray-400 px-2 py-1 text-sm text-gray-900">
        {value || "　"}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// FaceSheet Report
// ---------------------------------------------------------------------------

function FaceSheetReport({
  user,
  cert,
  insurance,
  adl,
  histories,
  contacts,
  healthRecords,
}: {
  user: KaigoUser;
  cert: CareCertification | null;
  insurance: MedicalInsurance | null;
  adl: AdlRecord | null;
  histories: MedicalHistory[];
  contacts: FamilyContact[];
  healthRecords: HealthRecord[];
}) {
  const latestHealth = healthRecords[0] ?? null;

  const ADL_ITEMS: [keyof AdlRecord, string][] = [
    ["eating", "食事"],
    ["transfer", "移乗"],
    ["grooming", "整容"],
    ["toilet", "トイレ"],
    ["bathing", "入浴"],
    ["mobility", "移動"],
    ["stairs", "階段"],
    ["dressing", "更衣"],
    ["bowel", "排便"],
    ["bladder", "排尿"],
  ];

  return (
    <div className="space-y-5 text-sm">
      {/* Title */}
      <div className="text-center">
        <h1 className="text-xl font-bold tracking-wide">フェースシート</h1>
        <p className="text-xs text-gray-500 mt-1">
          作成日: {format(new Date(), "yyyy年M月d日", { locale: ja })}
        </p>
      </div>

      {/* 基本情報 */}
      <section>
        <h2 className="border-b-2 border-gray-800 pb-1 text-sm font-bold mb-2">
          基本情報
        </h2>
        <table className="w-full border-collapse text-xs">
          <tbody>
            <TR label="氏名（漢字）" value={user.name} />
            <TR label="氏名（かな）" value={user.name_kana} />
            <TR
              label="性別"
              value={`${user.gender}　（${calcAge(user.birth_date)}）`}
            />
            <TR label="生年月日" value={fmtDate(user.birth_date)} />
            <TR label="血液型" value={user.blood_type} />
            <TR
              label="住所"
              value={
                user.address
                  ? `〒${user.postal_code ?? ""}　${user.address}`
                  : null
              }
            />
            <TR label="電話番号" value={user.phone} />
            <TR label="携帯電話" value={user.mobile_phone} />
            <TR
              label="緊急連絡先"
              value={
                user.emergency_contact_name
                  ? `${user.emergency_contact_name}　${user.emergency_contact_phone ?? ""}`
                  : null
              }
            />
            <TR label="入所日" value={fmtDate(user.admission_date)} />
          </tbody>
        </table>
      </section>

      {/* 介護認定 */}
      <section>
        <h2 className="border-b-2 border-gray-800 pb-1 text-sm font-bold mb-2">
          介護保険認定情報
        </h2>
        {cert ? (
          <table className="w-full border-collapse text-xs">
            <tbody>
              <TR label="介護度" value={cert.care_level} />
              <TR label="認定番号" value={cert.certification_number} />
              <TR label="保険者番号" value={cert.insurer_number} />
              <TR label="被保険者番号" value={cert.insured_number} />
              <TR label="有効期間" value={`${fmtDate(cert.start_date)} 〜 ${fmtDate(cert.end_date)}`} />
              <TR
                label="支給限度基準額"
                value={
                  cert.support_limit_amount != null
                    ? fmtCurrency(cert.support_limit_amount)
                    : null
                }
              />
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-gray-500 border border-gray-300 px-3 py-2">
            介護認定情報なし
          </p>
        )}
      </section>

      {/* 医療保険 */}
      <section>
        <h2 className="border-b-2 border-gray-800 pb-1 text-sm font-bold mb-2">
          医療保険情報
        </h2>
        {insurance ? (
          <table className="w-full border-collapse text-xs">
            <tbody>
              <TR label="保険種別" value={insurance.insurance_type} />
              <TR label="保険者番号" value={insurance.insurer_number} />
              <TR label="被保険者番号" value={insurance.insured_number} />
              <TR label="有効期間" value={`${fmtDate(insurance.start_date)} 〜 ${fmtDate(insurance.end_date)}`} />
              <TR
                label="自己負担割合"
                value={`${insurance.copay_rate}割`}
              />
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-gray-500 border border-gray-300 px-3 py-2">
            医療保険情報なし
          </p>
        )}
      </section>

      {/* ADL */}
      <section>
        <h2 className="border-b-2 border-gray-800 pb-1 text-sm font-bold mb-2">
          ADL（日常生活動作）評価
        </h2>
        {adl ? (
          <>
            <p className="text-xs text-gray-500 mb-2">
              評価日: {fmtDate(adl.assessment_date)}　評価者:{" "}
              {adl.assessor_name ?? "　"}　合計スコア:{" "}
              <strong>{adl.total_score}</strong> / 100
            </p>
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-gray-100">
                  {ADL_ITEMS.map(([, label]) => (
                    <th
                      key={label}
                      className="border border-gray-400 px-1.5 py-1 font-medium text-center"
                    >
                      {label}
                    </th>
                  ))}
                  <th className="border border-gray-400 px-1.5 py-1 font-medium text-center">
                    合計
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  {ADL_ITEMS.map(([key, label]) => (
                    <td
                      key={label}
                      className="border border-gray-400 px-1.5 py-1 text-center"
                    >
                      {String(adl[key])}
                    </td>
                  ))}
                  <td className="border border-gray-400 px-1.5 py-1 text-center font-bold">
                    {adl.total_score}
                  </td>
                </tr>
              </tbody>
            </table>
          </>
        ) : (
          <p className="text-xs text-gray-500 border border-gray-300 px-3 py-2">
            ADL評価記録なし
          </p>
        )}
      </section>

      {/* 既往歴 */}
      <section>
        <h2 className="border-b-2 border-gray-800 pb-1 text-sm font-bold mb-2">
          既往歴・疾患
        </h2>
        {histories.length > 0 ? (
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="bg-gray-100">
                <th className="border border-gray-400 px-2 py-1 font-medium text-left">
                  疾患名
                </th>
                <th className="border border-gray-400 px-2 py-1 font-medium text-left w-28">
                  発症日
                </th>
                <th className="border border-gray-400 px-2 py-1 font-medium text-left w-24">
                  状態
                </th>
                <th className="border border-gray-400 px-2 py-1 font-medium text-left">
                  医療機関
                </th>
              </tr>
            </thead>
            <tbody>
              {histories.map((h) => (
                <tr key={h.id}>
                  <td className="border border-gray-400 px-2 py-1">
                    {h.disease_name}
                  </td>
                  <td className="border border-gray-400 px-2 py-1">
                    {fmtDate(h.onset_date)}
                  </td>
                  <td className="border border-gray-400 px-2 py-1">
                    {h.status}
                  </td>
                  <td className="border border-gray-400 px-2 py-1">
                    {h.hospital ?? "　"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-gray-500 border border-gray-300 px-3 py-2">
            既往歴記録なし
          </p>
        )}
      </section>

      {/* 家族・関係者 */}
      <section>
        <h2 className="border-b-2 border-gray-800 pb-1 text-sm font-bold mb-2">
          家族・関係者連絡先
        </h2>
        {contacts.length > 0 ? (
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="bg-gray-100">
                <th className="border border-gray-400 px-2 py-1 font-medium text-left">
                  氏名
                </th>
                <th className="border border-gray-400 px-2 py-1 font-medium text-left w-24">
                  続柄
                </th>
                <th className="border border-gray-400 px-2 py-1 font-medium text-left">
                  電話番号
                </th>
                <th className="border border-gray-400 px-2 py-1 font-medium text-left">
                  住所
                </th>
                <th className="border border-gray-400 px-2 py-1 font-medium text-center w-16">
                  キーパーソン
                </th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id}>
                  <td className="border border-gray-400 px-2 py-1">{c.name}</td>
                  <td className="border border-gray-400 px-2 py-1">
                    {c.relationship}
                  </td>
                  <td className="border border-gray-400 px-2 py-1">
                    {c.phone ?? "　"}
                  </td>
                  <td className="border border-gray-400 px-2 py-1">
                    {c.address ?? "　"}
                  </td>
                  <td className="border border-gray-400 px-2 py-1 text-center">
                    {c.is_key_person ? "◎" : "　"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-gray-500 border border-gray-300 px-3 py-2">
            家族情報なし
          </p>
        )}
      </section>

      {/* 最新バイタル */}
      <section>
        <h2 className="border-b-2 border-gray-800 pb-1 text-sm font-bold mb-2">
          直近の健康記録
        </h2>
        {latestHealth ? (
          <table className="w-full border-collapse text-xs">
            <tbody>
              <TR
                label="測定日"
                value={fmtDate(latestHealth.record_date)}
              />
              <TR
                label="体温"
                value={
                  latestHealth.temperature != null
                    ? `${latestHealth.temperature}℃`
                    : null
                }
              />
              <TR
                label="血圧"
                value={
                  latestHealth.blood_pressure_sys != null
                    ? `${latestHealth.blood_pressure_sys} / ${latestHealth.blood_pressure_dia ?? "—"} mmHg`
                    : null
                }
              />
              <TR
                label="脈拍"
                value={
                  latestHealth.pulse != null
                    ? `${latestHealth.pulse} 回/分`
                    : null
                }
              />
              <TR
                label="体重"
                value={
                  latestHealth.weight != null
                    ? `${latestHealth.weight} kg`
                    : null
                }
              />
              <TR
                label="SpO2"
                value={
                  latestHealth.spo2 != null
                    ? `${latestHealth.spo2}%`
                    : null
                }
              />
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-gray-500 border border-gray-300 px-3 py-2">
            健康記録なし
          </p>
        )}
      </section>

      {/* 備考 */}
      {user.notes && (
        <section>
          <h2 className="border-b-2 border-gray-800 pb-1 text-sm font-bold mb-2">
            備考
          </h2>
          <p className="border border-gray-300 px-3 py-2 text-xs whitespace-pre-wrap">
            {user.notes}
          </p>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CarePlan1 Report
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
  return (
    <div className="space-y-5 text-sm">
      <div className="text-center">
        <h1 className="text-xl font-bold tracking-wide">
          居宅サービス計画書（第1表）
        </h1>
        <p className="text-xs text-gray-500 mt-1">
          作成日: {format(new Date(), "yyyy年M月d日", { locale: ja })}
        </p>
      </div>

      {/* 利用者基本情報 */}
      <section>
        <h2 className="border-b-2 border-gray-800 pb-1 text-sm font-bold mb-2">
          利用者基本情報
        </h2>
        <table className="w-full border-collapse text-xs">
          <tbody>
            <TR label="利用者氏名" value={user.name} />
            <TR
              label="ふりがな"
              value={user.name_kana}
            />
            <TR
              label="生年月日・年齢"
              value={`${fmtDate(user.birth_date)}（${calcAge(user.birth_date)}）`}
            />
            <TR label="性別" value={user.gender} />
            <TR
              label="住所"
              value={
                user.address
                  ? `〒${user.postal_code ?? ""}　${user.address}`
                  : null
              }
            />
            <TR label="電話番号" value={user.phone} />
            <TR label="認定有効期間" value={cert ? `${fmtDate(cert.start_date)} 〜 ${fmtDate(cert.end_date)}` : null} />
            <TR label="要介護状態区分" value={cert?.care_level} />
            <TR label="被保険者番号" value={cert?.insured_number} />
            <TR label="保険者番号・名称" value={cert?.insurer_number} />
          </tbody>
        </table>
      </section>

      {/* ケアプラン情報 */}
      {plan ? (
        <>
          <section>
            <h2 className="border-b-2 border-gray-800 pb-1 text-sm font-bold mb-2">
              居宅サービス計画情報
            </h2>
            <table className="w-full border-collapse text-xs">
              <tbody>
                <TR label="計画番号" value={plan.plan_number} />
                <TR label="計画種別" value={plan.plan_type} />
                <TR
                  label="計画期間"
                  value={`${fmtDate(plan.start_date)} 〜 ${fmtDate(plan.end_date)}`}
                />
                <TR
                  label="ステータス"
                  value={
                    plan.status === "active"
                      ? "有効"
                      : plan.status === "draft"
                        ? "下書き"
                        : plan.status === "completed"
                          ? "完了"
                          : "取消"
                  }
                />
              </tbody>
            </table>
          </section>

          {/* 総合的な援助の方針 */}
          <section>
            <h2 className="border-b-2 border-gray-800 pb-1 text-sm font-bold mb-2">
              利用者及び家族の生活に対する意向・総合的な援助の方針
            </h2>
            <table className="w-full border-collapse text-xs">
              <tbody>
                <tr>
                  <td className="border border-gray-400 bg-gray-100 px-2 py-1 font-medium text-gray-700 align-top w-28 whitespace-nowrap">
                    長期目標
                  </td>
                  <td className="border border-gray-400 px-2 py-2 whitespace-pre-wrap leading-relaxed">
                    {plan.long_term_goals || "（未入力）"}
                  </td>
                </tr>
                <tr>
                  <td className="border border-gray-400 bg-gray-100 px-2 py-1 font-medium text-gray-700 align-top w-28 whitespace-nowrap">
                    短期目標・方針
                  </td>
                  <td className="border border-gray-400 px-2 py-2 whitespace-pre-wrap leading-relaxed">
                    {plan.short_term_goals || "（未入力）"}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        </>
      ) : (
        <p className="text-xs text-gray-500 border border-gray-300 px-3 py-2">
          有効なケアプランがありません
        </p>
      )}

      {/* 署名欄 */}
      <section className="mt-8">
        <table className="w-full border-collapse text-xs">
          <tbody>
            <tr>
              <td className="border border-gray-400 bg-gray-100 px-2 py-1 font-medium w-40">
                介護支援専門員氏名
              </td>
              <td className="border border-gray-400 px-2 py-1 h-8"></td>
              <td className="border border-gray-400 bg-gray-100 px-2 py-1 font-medium w-32">
                事業所名
              </td>
              <td className="border border-gray-400 px-2 py-1 h-8"></td>
            </tr>
            <tr>
              <td className="border border-gray-400 bg-gray-100 px-2 py-1 font-medium">
                利用者署名・捺印
              </td>
              <td className="border border-gray-400 px-2 py-1 h-12"></td>
              <td className="border border-gray-400 bg-gray-100 px-2 py-1 font-medium">
                家族署名・捺印
              </td>
              <td className="border border-gray-400 px-2 py-1 h-12"></td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CarePlan2 Report
// ---------------------------------------------------------------------------

function CarePlan2Report({
  user,
  plan,
  services,
}: {
  user: KaigoUser;
  plan: CarePlan | null;
  services: CarePlanService[];
}) {
  return (
    <div className="space-y-5 text-sm">
      <div className="text-center">
        <h1 className="text-xl font-bold tracking-wide">
          居宅サービス計画書（第2表）
        </h1>
        <p className="text-xs text-gray-500 mt-1">
          作成日: {format(new Date(), "yyyy年M月d日", { locale: ja })}
        </p>
      </div>

      {/* 基本情報 */}
      <section>
        <table className="w-full border-collapse text-xs">
          <tbody>
            <TR label="利用者氏名" value={user.name} />
            <TR
              label="計画期間"
              value={
                plan
                  ? `${fmtDate(plan.start_date)} 〜 ${fmtDate(plan.end_date)}`
                  : null
              }
            />
          </tbody>
        </table>
      </section>

      {/* 目標 */}
      {plan && (
        <section>
          <h2 className="border-b-2 border-gray-800 pb-1 text-sm font-bold mb-2">
            生活全般の解決すべき課題（ニーズ）・目標
          </h2>
          <table className="w-full border-collapse text-xs">
            <tbody>
              <tr>
                <td className="border border-gray-400 bg-gray-100 px-2 py-1 font-medium text-gray-700 align-top w-28">
                  長期目標
                  <br />
                  <span className="font-normal text-gray-500">（期間）</span>
                </td>
                <td className="border border-gray-400 px-2 py-2 whitespace-pre-wrap leading-relaxed">
                  {plan.long_term_goals || "（未入力）"}
                </td>
              </tr>
              <tr>
                <td className="border border-gray-400 bg-gray-100 px-2 py-1 font-medium text-gray-700 align-top w-28">
                  短期目標
                  <br />
                  <span className="font-normal text-gray-500">（期間）</span>
                </td>
                <td className="border border-gray-400 px-2 py-2 whitespace-pre-wrap leading-relaxed">
                  {plan.short_term_goals || "（未入力）"}
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      )}

      {/* サービス一覧 */}
      <section>
        <h2 className="border-b-2 border-gray-800 pb-1 text-sm font-bold mb-2">
          援助内容（サービス内容）
        </h2>
        {services.length > 0 ? (
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="bg-gray-100">
                <th className="border border-gray-400 px-2 py-1.5 font-medium text-left">
                  サービス種別
                </th>
                <th className="border border-gray-400 px-2 py-1.5 font-medium text-left">
                  サービス内容
                </th>
                <th className="border border-gray-400 px-2 py-1.5 font-medium text-left w-20">
                  頻度
                </th>
                <th className="border border-gray-400 px-2 py-1.5 font-medium text-left">
                  担当者・提供事業所
                </th>
                <th className="border border-gray-400 px-2 py-1.5 font-medium text-left">
                  備考
                </th>
              </tr>
            </thead>
            <tbody>
              {services.map((svc, i) => (
                <tr key={svc.id || i}>
                  <td className="border border-gray-400 px-2 py-1.5">
                    {svc.service_type}
                  </td>
                  <td className="border border-gray-400 px-2 py-1.5">
                    {svc.service_content}
                  </td>
                  <td className="border border-gray-400 px-2 py-1.5">
                    {svc.frequency ?? "　"}
                  </td>
                  <td className="border border-gray-400 px-2 py-1.5">
                    {svc.provider ?? "　"}
                  </td>
                  <td className="border border-gray-400 px-2 py-1.5">
                    {svc.notes ?? "　"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-gray-500 border border-gray-300 px-3 py-2">
            サービス登録なし
          </p>
        )}
      </section>

      {/* 署名欄 */}
      <section className="mt-6">
        <table className="w-full border-collapse text-xs">
          <tbody>
            <tr>
              <td className="border border-gray-400 bg-gray-100 px-2 py-1 font-medium w-40">
                介護支援専門員氏名
              </td>
              <td className="border border-gray-400 px-2 py-1 h-8"></td>
              <td className="border border-gray-400 bg-gray-100 px-2 py-1 font-medium w-32">
                事業所番号
              </td>
              <td className="border border-gray-400 px-2 py-1 h-8"></td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ServiceUsage Report
// ---------------------------------------------------------------------------

function ServiceUsageReport({
  user,
  records,
  yearMonth,
}: {
  user: KaigoUser;
  records: ServiceRecord[];
  yearMonth: string;
}) {
  const monthDate = parseISO(`${yearMonth}-01`);
  const daysInMonth = getDaysInMonth(monthDate);
  const firstDayOfWeek = getDay(startOfMonth(monthDate)); // 0=Sun

  const WEEK_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

  // Map service records by day
  const dayMap: Record<number, ServiceRecord[]> = {};
  for (const r of records) {
    const day = parseInt(r.service_date.split("-")[2], 10);
    if (!dayMap[day]) dayMap[day] = [];
    dayMap[day].push(r);
  }

  // Build calendar grid (weeks × 7)
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDayOfWeek; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }

  return (
    <div className="space-y-5 text-sm">
      <div className="text-center">
        <h1 className="text-xl font-bold tracking-wide">サービス利用票</h1>
        <p className="text-xs text-gray-500 mt-1">
          {fmtJaYear(yearMonth + "-01")} 分
        </p>
      </div>

      <section>
        <table className="w-full border-collapse text-xs mb-4">
          <tbody>
            <TR label="利用者氏名" value={user.name} />
            <TR label="対象月" value={fmtJaYear(yearMonth + "-01")} />
          </tbody>
        </table>
      </section>

      {/* Calendar */}
      <section>
        <h2 className="border-b-2 border-gray-800 pb-1 text-sm font-bold mb-2">
          サービス利用カレンダー
        </h2>
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              {WEEK_LABELS.map((d, i) => (
                <th
                  key={d}
                  className={`border border-gray-400 py-1 text-center font-medium ${
                    i === 0
                      ? "text-red-600 bg-red-50"
                      : i === 6
                        ? "text-blue-600 bg-blue-50"
                        : "bg-gray-100"
                  }`}
                >
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week, wi) => (
              <tr key={wi}>
                {week.map((day, di) => {
                  const svcList = day ? (dayMap[day] ?? []) : [];
                  return (
                    <td
                      key={di}
                      className={`border border-gray-400 align-top p-1 h-16 w-[14.28%] ${
                        !day
                          ? "bg-gray-50"
                          : di === 0
                            ? "bg-red-50/30"
                            : di === 6
                              ? "bg-blue-50/30"
                              : ""
                      }`}
                    >
                      {day && (
                        <>
                          <div
                            className={`text-xs font-medium mb-0.5 ${
                              di === 0
                                ? "text-red-600"
                                : di === 6
                                  ? "text-blue-600"
                                  : "text-gray-700"
                            }`}
                          >
                            {day}
                          </div>
                          {svcList.map((svc, si) => (
                            <div
                              key={si}
                              className="text-xs text-blue-700 bg-blue-50 rounded px-0.5 mb-0.5 leading-tight truncate"
                              title={svc.service_type}
                            >
                              {svc.service_type}
                            </div>
                          ))}
                        </>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Detail List */}
      {records.length > 0 && (
        <section>
          <h2 className="border-b-2 border-gray-800 pb-1 text-sm font-bold mb-2">
            サービス利用明細
          </h2>
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="bg-gray-100">
                <th className="border border-gray-400 px-2 py-1.5 font-medium text-left w-24">
                  利用日
                </th>
                <th className="border border-gray-400 px-2 py-1.5 font-medium text-left">
                  サービス種別
                </th>
                <th className="border border-gray-400 px-2 py-1.5 font-medium text-left w-24">
                  開始
                </th>
                <th className="border border-gray-400 px-2 py-1.5 font-medium text-left w-24">
                  終了
                </th>
                <th className="border border-gray-400 px-2 py-1.5 font-medium text-left">
                  内容
                </th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id}>
                  <td className="border border-gray-400 px-2 py-1">
                    {fmtDate(r.service_date)}
                  </td>
                  <td className="border border-gray-400 px-2 py-1">
                    {r.service_type}
                  </td>
                  <td className="border border-gray-400 px-2 py-1">
                    {r.start_time ? r.start_time.slice(0, 5) : "　"}
                  </td>
                  <td className="border border-gray-400 px-2 py-1">
                    {r.end_time ? r.end_time.slice(0, 5) : "　"}
                  </td>
                  <td className="border border-gray-400 px-2 py-1">
                    {r.content ?? "　"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ServiceProvision Report
// ---------------------------------------------------------------------------

function ServiceProvisionReport({
  user,
  records,
  yearMonth,
  planServices,
}: {
  user: KaigoUser;
  records: ServiceRecord[];
  yearMonth: string;
  planServices: CarePlanService[];
}) {
  const monthDate = parseISO(`${yearMonth}-01`);
  const daysInMonth = getDaysInMonth(monthDate);

  // Group actual records by service_type and by day
  const actualByTypeDay: Record<string, Set<number>> = {};
  for (const r of records) {
    if (!actualByTypeDay[r.service_type]) {
      actualByTypeDay[r.service_type] = new Set();
    }
    const day = parseInt(r.service_date.split("-")[2], 10);
    actualByTypeDay[r.service_type].add(day);
  }

  // Collect all service types from both plan and actual
  const planTypes = planServices.map((s) => s.service_type);
  const actualTypes = Object.keys(actualByTypeDay);
  const allTypes = [...new Set([...planTypes, ...actualTypes])];

  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  return (
    <div className="space-y-5 text-sm">
      <div className="text-center">
        <h1 className="text-xl font-bold tracking-wide">サービス提供票</h1>
        <p className="text-xs text-gray-500 mt-1">
          {fmtJaYear(yearMonth + "-01")} 分
        </p>
      </div>

      <section>
        <table className="w-full border-collapse text-xs mb-4">
          <tbody>
            <TR label="利用者氏名" value={user.name} />
            <TR label="対象月" value={fmtJaYear(yearMonth + "-01")} />
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="border-b-2 border-gray-800 pb-1 text-sm font-bold mb-2">
          サービス提供状況（計画・実績対比）
        </h2>
        <p className="text-xs text-gray-500 mb-2">
          ■ = 実績あり　□ = 計画のみ（実績なし）
        </p>

        {allTypes.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="border-collapse text-xs" style={{ minWidth: "100%" }}>
              <thead>
                <tr className="bg-gray-100">
                  <th className="border border-gray-400 px-2 py-1.5 font-medium text-left w-32 whitespace-nowrap">
                    サービス種別
                  </th>
                  <th className="border border-gray-400 px-2 py-1.5 font-medium text-left w-24 whitespace-nowrap">
                    提供事業所
                  </th>
                  {days.map((d) => (
                    <th
                      key={d}
                      className="border border-gray-400 px-1 py-1.5 font-medium text-center w-6"
                    >
                      {d}
                    </th>
                  ))}
                  <th className="border border-gray-400 px-2 py-1.5 font-medium text-center w-12">
                    合計
                  </th>
                </tr>
              </thead>
              <tbody>
                {allTypes.map((svcType) => {
                  const planSvc = planServices.find(
                    (s) => s.service_type === svcType
                  );
                  const actualDays = actualByTypeDay[svcType] ?? new Set<number>();
                  const count = actualDays.size;
                  return (
                    <tr key={svcType}>
                      <td className="border border-gray-400 px-2 py-1 whitespace-nowrap">
                        {svcType}
                      </td>
                      <td className="border border-gray-400 px-2 py-1 text-gray-600">
                        {planSvc?.provider ?? "　"}
                      </td>
                      {days.map((d) => {
                        const hasActual = actualDays.has(d);
                        return (
                          <td
                            key={d}
                            className={`border border-gray-400 px-0.5 py-1 text-center ${hasActual ? "bg-blue-50" : ""}`}
                          >
                            {hasActual ? "■" : ""}
                          </td>
                        );
                      })}
                      <td className="border border-gray-400 px-2 py-1 text-center font-medium">
                        {count}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-gray-500 border border-gray-300 px-3 py-2">
            サービスデータなし
          </p>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invoice Report
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
  const totalAmount = billingRecords.reduce(
    (s, r) => s + (r.total_amount ?? 0),
    0
  );
  const totalInsurance = billingRecords.reduce(
    (s, r) => s + (r.insurance_amount ?? 0),
    0
  );
  const totalCopay = billingRecords.reduce(
    (s, r) => s + (r.copay_amount ?? 0),
    0
  );

  // Map details by billing_record_id
  const detailMap: Record<string, BillingDetail[]> = {};
  for (const d of billingDetails) {
    if (!detailMap[d.billing_record_id]) detailMap[d.billing_record_id] = [];
    detailMap[d.billing_record_id].push(d);
  }

  return (
    <div className="space-y-5 text-sm">
      <div className="text-center">
        <h1 className="text-xl font-bold tracking-wide">請求書</h1>
        <p className="text-xs text-gray-500 mt-1">
          {fmtJaYear(yearMonth + "-01")} 分
        </p>
        <p className="text-xs text-gray-500">
          発行日: {format(new Date(), "yyyy年M月d日", { locale: ja })}
        </p>
      </div>

      {/* 宛先・請求先 */}
      <section>
        <table className="w-full border-collapse text-xs">
          <tbody>
            <TR label="利用者氏名" value={`${user.name}　様`} />
            <TR label="住所" value={user.address} />
            <TR label="対象月" value={fmtJaYear(yearMonth + "-01")} />
          </tbody>
        </table>
      </section>

      {/* 請求概要 */}
      <section>
        <h2 className="border-b-2 border-gray-800 pb-1 text-sm font-bold mb-2">
          請求概要
        </h2>
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-gray-100">
              <th className="border border-gray-400 px-2 py-1.5 font-medium text-left">
                サービス種別
              </th>
              <th className="border border-gray-400 px-2 py-1.5 font-medium text-right w-20">
                総単位数
              </th>
              <th className="border border-gray-400 px-2 py-1.5 font-medium text-right w-24">
                単位単価
              </th>
              <th className="border border-gray-400 px-2 py-1.5 font-medium text-right w-28">
                総費用額
              </th>
              <th className="border border-gray-400 px-2 py-1.5 font-medium text-right w-28">
                保険給付額
              </th>
              <th className="border border-gray-400 px-2 py-1.5 font-medium text-right w-28">
                自己負担額
              </th>
              <th className="border border-gray-400 px-2 py-1.5 font-medium text-center w-20">
                状態
              </th>
            </tr>
          </thead>
          <tbody>
            {billingRecords.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="border border-gray-400 px-2 py-3 text-center text-gray-500"
                >
                  請求データなし
                </td>
              </tr>
            ) : (
              billingRecords.map((rec) => (
                <tr key={rec.id}>
                  <td className="border border-gray-400 px-2 py-1">
                    {rec.service_type}
                  </td>
                  <td className="border border-gray-400 px-2 py-1 text-right">
                    {rec.total_units.toLocaleString()}
                  </td>
                  <td className="border border-gray-400 px-2 py-1 text-right">
                    {rec.unit_price.toLocaleString()}円
                  </td>
                  <td className="border border-gray-400 px-2 py-1 text-right">
                    {fmtCurrency(rec.total_amount)}
                  </td>
                  <td className="border border-gray-400 px-2 py-1 text-right">
                    {fmtCurrency(rec.insurance_amount)}
                  </td>
                  <td className="border border-gray-400 px-2 py-1 text-right font-medium">
                    {fmtCurrency(rec.copay_amount)}
                  </td>
                  <td className="border border-gray-400 px-2 py-1 text-center">
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-xs ${
                        rec.status === "paid"
                          ? "bg-green-100 text-green-700"
                          : rec.status === "submitted"
                            ? "bg-blue-100 text-blue-700"
                            : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {rec.status === "paid"
                        ? "支払済"
                        : rec.status === "submitted"
                          ? "請求済"
                          : "下書き"}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
          {billingRecords.length > 0 && (
            <tfoot>
              <tr className="bg-gray-50 font-bold">
                <td
                  colSpan={3}
                  className="border border-gray-400 px-2 py-1.5 text-right"
                >
                  合計
                </td>
                <td className="border border-gray-400 px-2 py-1.5 text-right">
                  {fmtCurrency(totalAmount)}
                </td>
                <td className="border border-gray-400 px-2 py-1.5 text-right">
                  {fmtCurrency(totalInsurance)}
                </td>
                <td className="border border-gray-400 px-2 py-1.5 text-right text-red-700">
                  {fmtCurrency(totalCopay)}
                </td>
                <td className="border border-gray-400"></td>
              </tr>
            </tfoot>
          )}
        </table>
      </section>

      {/* 明細 */}
      {billingDetails.length > 0 && (
        <section>
          <h2 className="border-b-2 border-gray-800 pb-1 text-sm font-bold mb-2">
            請求明細
          </h2>
          {billingRecords.map((rec) => {
            const details = detailMap[rec.id] ?? [];
            if (details.length === 0) return null;
            return (
              <div key={rec.id} className="mb-4">
                <p className="text-xs font-semibold text-gray-700 mb-1 bg-gray-100 px-2 py-1 border border-gray-300">
                  {rec.service_type}
                </p>
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="bg-gray-50">
                      <th className="border border-gray-400 px-2 py-1 font-medium text-left w-24">
                        サービス日
                      </th>
                      <th className="border border-gray-400 px-2 py-1 font-medium text-left w-28">
                        サービスコード
                      </th>
                      <th className="border border-gray-400 px-2 py-1 font-medium text-left">
                        サービス名称
                      </th>
                      <th className="border border-gray-400 px-2 py-1 font-medium text-right w-16">
                        単位数
                      </th>
                      <th className="border border-gray-400 px-2 py-1 font-medium text-right w-24">
                        金額
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {details.map((d) => (
                      <tr key={d.id}>
                        <td className="border border-gray-400 px-2 py-1">
                          {fmtDate(d.service_date)}
                        </td>
                        <td className="border border-gray-400 px-2 py-1 font-mono">
                          {d.service_code}
                        </td>
                        <td className="border border-gray-400 px-2 py-1">
                          {d.service_name}
                        </td>
                        <td className="border border-gray-400 px-2 py-1 text-right">
                          {d.units.toLocaleString()}
                        </td>
                        <td className="border border-gray-400 px-2 py-1 text-right">
                          {fmtCurrency(d.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </section>
      )}

      {/* 自己負担合計ハイライト */}
      {billingRecords.length > 0 && (
        <section className="border-2 border-gray-800 rounded p-4 mt-4">
          <div className="flex items-center justify-between">
            <span className="font-bold text-base">
              今月のご請求額（自己負担合計）
            </span>
            <span className="text-2xl font-bold text-red-700">
              {fmtCurrency(totalCopay)}
            </span>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            ※ 上記金額は概算です。確定額については別途ご確認ください。
          </p>
        </section>
      )}
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

  // --- Step state ---
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedYearMonth, setSelectedYearMonth] = useState(
    format(new Date(), "yyyy-MM")
  );
  const [showReport, setShowReport] = useState(false);

  // --- Data lists ---
  const [userList, setUserList] = useState<{ id: string; name: string }[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);

  // --- Report data ---
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // individual data states
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
  }, [supabase]);

  // Generate report
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

      if (reportType === "face-sheet") {
        // Care certification
        const { data: certData } = await supabase
          .from("kaigo_care_certifications")
          .select("*")
          .eq("user_id", selectedUserId)
          .eq("status", "active")
          .order("start_date", { ascending: false })
          .limit(1);
        setCert(certData?.[0] ?? null);

        // Medical insurance
        const { data: insData } = await supabase
          .from("kaigo_medical_insurances")
          .select("*")
          .eq("user_id", selectedUserId)
          .order("created_at", { ascending: false })
          .limit(1);
        setInsurance(insData?.[0] ?? null);

        // ADL
        const { data: adlData } = await supabase
          .from("kaigo_adl_records")
          .select("*")
          .eq("user_id", selectedUserId)
          .order("assessment_date", { ascending: false })
          .limit(1);
        setAdl(adlData?.[0] ?? null);

        // Medical history
        const { data: histData } = await supabase
          .from("kaigo_medical_histories")
          .select("*")
          .eq("user_id", selectedUserId)
          .order("onset_date", { ascending: false });
        setHistories(histData ?? []);

        // Family contacts
        const { data: famData } = await supabase
          .from("kaigo_family_contacts")
          .select("*")
          .eq("user_id", selectedUserId)
          .order("is_key_person", { ascending: false });
        setContacts(famData ?? []);

        // Health records
        const { data: hrData } = await supabase
          .from("kaigo_health_records")
          .select("*")
          .eq("user_id", selectedUserId)
          .order("record_date", { ascending: false })
          .limit(5);
        setHealthRecords(hrData ?? []);
      }

      if (reportType === "care-plan-1" || reportType === "care-plan-2") {
        // Active care certification
        const { data: certData } = await supabase
          .from("kaigo_care_certifications")
          .select("*")
          .eq("user_id", selectedUserId)
          .eq("status", "active")
          .order("start_date", { ascending: false })
          .limit(1);
        setCert(certData?.[0] ?? null);

        // Active care plan
        const { data: planData } = await supabase
          .from("kaigo_care_plans")
          .select("*")
          .eq("user_id", selectedUserId)
          .eq("status", "active")
          .order("start_date", { ascending: false })
          .limit(1);
        const activePlan = planData?.[0] ?? null;
        setCarePlan(activePlan);

        if (activePlan && reportType === "care-plan-2") {
          const { data: svcData } = await supabase
            .from("kaigo_care_plan_services")
            .select("*")
            .eq("care_plan_id", activePlan.id);
          setPlanServices(svcData ?? []);
        }
      }

      if (
        reportType === "service-usage" ||
        reportType === "service-provision"
      ) {
        const monthStart = `${selectedYearMonth}-01`;
        const [year, month] = selectedYearMonth.split("-").map(Number);
        const lastDay = getDaysInMonth(new Date(year, month - 1));
        const monthEnd = `${selectedYearMonth}-${String(lastDay).padStart(2, "0")}`;

        const { data: srData, error: sre } = await supabase
          .from("kaigo_service_records")
          .select("*")
          .eq("user_id", selectedUserId)
          .gte("service_date", monthStart)
          .lte("service_date", monthEnd)
          .order("service_date", { ascending: true });
        if (sre) throw sre;
        setServiceRecords(srData ?? []);

        if (reportType === "service-provision") {
          // Also get plan services for planned vs actual
          const { data: planData } = await supabase
            .from("kaigo_care_plans")
            .select("id")
            .eq("user_id", selectedUserId)
            .eq("status", "active")
            .order("start_date", { ascending: false })
            .limit(1);
          const activePlanId = planData?.[0]?.id;
          if (activePlanId) {
            const { data: svcData } = await supabase
              .from("kaigo_care_plan_services")
              .select("*")
              .eq("care_plan_id", activePlanId);
            setPlanServices(svcData ?? []);
          } else {
            setPlanServices([]);
          }
        }
      }

      if (reportType === "invoice") {
        const monthStart = `${selectedYearMonth}-01`;
        const [year, month] = selectedYearMonth.split("-").map(Number);
        const lastDay = getDaysInMonth(new Date(year, month - 1));
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

  // Generate year-month options: current month ± 12 months
  const monthOptions: string[] = [];
  for (let i = -12; i <= 2; i++) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() + i);
    monthOptions.push(format(d, "yyyy-MM"));
  }
  monthOptions.sort((a, b) => b.localeCompare(a)); // newest first

  if (!config) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-gray-500">
        <AlertTriangle size={40} className="mb-3 text-amber-400" />
        <p className="text-lg font-semibold text-gray-700">
          不明な帳票種別です
        </p>
        <Link
          href="/reports"
          className="mt-4 text-sm text-blue-600 hover:underline"
        >
          帳票一覧に戻る
        </Link>
      </div>
    );
  }

  return (
    <>
      {/* Inject print styles */}
      <style>{PRINT_STYLE}</style>

      <div className="space-y-6">
        {/* Header */}
        <div className="no-print flex items-center gap-4">
          <Link
            href="/reports"
            className="flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <ChevronLeft size={16} />
            帳票一覧
          </Link>
          <div>
            <h1 className="text-xl font-bold text-gray-900">
              {config.titleJa}
            </h1>
            <p className="text-xs text-gray-500 mt-0.5">帳票作成・印刷</p>
          </div>
        </div>

        {/* Selection Panel */}
        <div className="no-print rounded-xl border bg-white p-6 shadow-sm">
          <h2 className="text-sm font-semibold text-gray-700 mb-4 pb-2 border-b">
            帳票条件の設定
          </h2>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            {/* User select */}
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-600 mb-1">
                利用者 <span className="text-red-500">*</span>
              </label>
              {usersLoading ? (
                <div className="flex items-center gap-2 text-sm text-gray-400 h-10">
                  <Loader2 size={14} className="animate-spin" />
                  読み込み中...
                </div>
              ) : (
                <select
                  value={selectedUserId}
                  onChange={(e) => {
                    setSelectedUserId(e.target.value);
                    setShowReport(false);
                  }}
                  className="w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">利用者を選択してください</option>
                  {userList.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* Month select (if needed) */}
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

        {/* Report Preview Area */}
        {showReport && user && (
          <div className="no-print-wrapper">
            {/* Screen preview wrapper */}
            <div className="no-print mb-3 flex items-center justify-between">
              <p className="text-sm text-gray-500">
                プレビュー（印刷するとA4サイズで出力されます）
              </p>
              <button
                onClick={() => window.print()}
                className="flex items-center gap-2 rounded-lg bg-gray-800 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-900 transition-colors"
              >
                <Printer size={14} />
                印刷
              </button>
            </div>

            {/* A4 Paper area */}
            <div
              id="print-area"
              className="mx-auto bg-white shadow-md"
              style={{
                width: "210mm",
                minHeight: "297mm",
                padding: "12mm 14mm",
                fontFamily:
                  '"Noto Sans JP", "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif',
                fontSize: "10pt",
                color: "#000",
                boxSizing: "border-box",
              }}
            >
              {reportType === "face-sheet" && (
                <FaceSheetReport
                  user={user}
                  cert={cert}
                  insurance={insurance}
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
                  plan={carePlan}
                  services={planServices}
                />
              )}

              {reportType === "service-usage" && (
                <ServiceUsageReport
                  user={user}
                  records={serviceRecords}
                  yearMonth={selectedYearMonth}
                />
              )}

              {reportType === "service-provision" && (
                <ServiceProvisionReport
                  user={user}
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

        {/* Empty state before generation */}
        {!showReport && !loading && (
          <div className="no-print flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-gray-50 py-20 text-gray-400">
            <FileText size={40} className="mb-3 opacity-40" />
            <p className="text-sm">
              利用者を選択して「帳票を生成」ボタンを押してください
            </p>
          </div>
        )}
      </div>
    </>
  );
}

