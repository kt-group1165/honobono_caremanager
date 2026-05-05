"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { UserSidebar } from "@/components/users/user-sidebar";
import { FileText, Printer, Loader2 } from "lucide-react";
import { format, parseISO } from "date-fns";
import { MeisaiForm } from "./_meisai";
import { SeikyuForm } from "./_seikyu";

// ─── Types ────────────────────────────────────────────────────────────────────

interface OfficeInfo {
  provider_number: string;
  office_name: string;
  address: string;
  phone: string;
  area_category: string;
  unit_price: number;
  postal_code: string;
}

interface UserInfo {
  id: string;
  name: string;
  name_kana: string;
  gender: string;
  birth_date: string;
}

interface CertInfo {
  insurer_number: string;
  insured_number: string;
  care_level: string;
  start_date: string;
  end_date: string;
}

interface ClaimRow {
  id: string;
  user_id: string;
  care_support_code: string;
  care_support_name: string;
  units: number;
  unit_price: number;
  total_amount: number;
  insurance_amount: number;
  initial_addition: boolean;
  initial_addition_units: number;
  tokutei_kassan_type: string | null;
  tokutei_kassan_units: number;
  medical_coop_kassan: boolean;
  medical_coop_kassan_units: number;
  hospital_coordination: boolean;
  hospital_coordination_units: number;
  discharge_addition: boolean;
  discharge_addition_units: number;
  medical_coordination: boolean;
  medical_coordination_units: number;
  terminal_care: boolean;
  terminal_care_units: number;
  emergency_conference: boolean;
  emergency_conference_units: number;
  status: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toWareki(dateStr: string): string {
  if (!dateStr) return "";
  try {
    const d = parseISO(dateStr);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    if (y >= 2019) return `令和${y - 2018}年${m}月${day}日`;
    if (y >= 1989) return `平成${y - 1988}年${m}月${day}日`;
    return `${y}年${m}月${day}日`;
  } catch {
    return dateStr;
  }
}

function toWarekiYM(ym: string): { era: string; year: number; month: number } {
  const [y, m] = ym.split("-").map(Number);
  if (y >= 2019) return { era: "令和", year: y - 2018, month: m };
  if (y >= 1989) return { era: "平成", year: y - 1988, month: m };
  return { era: "", year: y, month: m };
}

function careLevelCode(level: string): string {
  const map: Record<string, string> = {
    要支援1: "12", 要支援2: "13",
    要介護1: "21", 要介護2: "22", 要介護3: "23",
    要介護4: "24", 要介護5: "25",
  };
  return map[level] ?? "";
}

function getCurrentMonth(): string {
  return format(new Date(), "yyyy-MM");
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function BillingFormsPage() {
  const supabase = createClient();

  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [billingMonth, setBillingMonth] = useState(getCurrentMonth());
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"meisai" | "seikyu">("meisai");

  // Data
  const [office, setOffice] = useState<OfficeInfo | null>(null);
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [certInfo, setCertInfo] = useState<CertInfo | null>(null);
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [allClaims, setAllClaims] = useState<ClaimRow[]>([]); // 全利用者分（請求書用）

  // Load office info（offices, kaigo-app の自事業所だけ）
  // 共通マスタ: name → office_name, business_number → provider_number にマッピング
  useEffect(() => {
    supabase
      .from("offices")
      .select("name, business_number, address, phone, area_category, unit_price, postal_code")
      .eq("app_type", "kaigo-app")
      .limit(1)
      .maybeSingle()
      .then(({ data }: { data: { name: string | null; business_number: string | null; address: string | null; phone: string | null; area_category: string | null; unit_price: number | null; postal_code: string | null } | null }) => {
        if (data) setOffice({
          provider_number: data.business_number ?? "",
          office_name: data.name ?? "",
          address: data.address ?? "",
          phone: data.phone ?? "",
          area_category: data.area_category ?? "",
          unit_price: data.unit_price ?? 10,
          postal_code: data.postal_code ?? "",
        });
      });
  }, [supabase]);

  // Load user + cert + claims when user/month changes
  const fetchData = useCallback(async () => {
    if (!selectedUserId) {
      setUserInfo(null);
      setCertInfo(null);
      setClaims([]);
      return;
    }
    setLoading(true);
    try {
      // User（共通マスタ clients、furigana → name_kana にマッピング）
      const { data: u } = await supabase
        .from("clients")
        .select("id, name, furigana, gender, birth_date")
        .eq("id", selectedUserId)
        .single();
      setUserInfo(u ? {
        id: u.id,
        name: u.name ?? "",
        name_kana: u.furigana ?? "",
        gender: u.gender ?? "",
        birth_date: u.birth_date ?? "",
      } : null);

      // Cert（client_insurance_records、カラム名は新スキーマ）
      const { data: certs } = await supabase
        .from("client_insurance_records")
        .select("insurer_number, insured_number, care_level, certification_start_date, certification_end_date")
        .eq("client_id", selectedUserId)
        .order("certification_start_date", { ascending: false, nullsFirst: false })
        .limit(1);
      const cert = certs?.[0];
      setCertInfo(cert ? {
        insurer_number: cert.insurer_number ?? "",
        insured_number: cert.insured_number ?? "",
        care_level: cert.care_level ?? "",
        start_date: cert.certification_start_date ?? "",
        end_date: cert.certification_end_date ?? "",
      } : null);

      // Claims for this user + month
      const { data: claimData } = await supabase
        .from("kaigo_care_support_claims")
        .select("*")
        .eq("user_id", selectedUserId)
        .eq("billing_month", billingMonth)
        .neq("status", "draft");
      setClaims((claimData as ClaimRow[]) ?? []);
    } catch {
      toast.error("データの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [supabase, selectedUserId, billingMonth]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    fetchData();
  }, [fetchData]);

  // Load all claims for 請求書 (summary)
  const fetchAllClaims = useCallback(async () => {
    const { data } = await supabase
      .from("kaigo_care_support_claims")
      .select("*")
      .eq("billing_month", billingMonth)
      .neq("status", "draft");
    setAllClaims((data as ClaimRow[]) ?? []);
  }, [supabase, billingMonth]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    fetchAllClaims();
  }, [fetchAllClaims]);

  // Aggregated data for 請求書
  const seikyuSummary = useMemo(() => {
    const totalCount = allClaims.length;
    const totalUnits = allClaims.reduce((s, c) => s + c.units, 0);
    const addUnits = allClaims.reduce((s, c) => {
      let add = 0;
      if (c.initial_addition) add += c.initial_addition_units;
      if (c.tokutei_kassan_units) add += c.tokutei_kassan_units;
      if (c.medical_coop_kassan) add += (c.medical_coop_kassan_units ?? 125);
      if (c.hospital_coordination) add += c.hospital_coordination_units;
      if (c.discharge_addition) add += c.discharge_addition_units;
      if (c.medical_coordination) add += (c.medical_coordination_units ?? 50);
      if (c.terminal_care) add += (c.terminal_care_units ?? 400);
      if (c.emergency_conference) add += (c.emergency_conference_units ?? 200);
      return s + add;
    }, 0);
    const grandUnits = totalUnits + addUnits;
    const totalAmount = allClaims.reduce((s, c) => s + c.total_amount, 0);
    const insuranceAmount = allClaims.reduce((s, c) => s + c.insurance_amount, 0);
    const userCopay = 0; // 居宅介護支援は10割給付
    return { totalCount, totalUnits, addUnits, grandUnits, totalAmount, insuranceAmount, userCopay };
  }, [allClaims]);

  // Claim detail for 明細書
  const meisaiDetail = useMemo(() => {
    if (claims.length === 0) return null;
    const c = claims[0];
    const addLines: { name: string; code: string; units: number; count: number }[] = [];
    addLines.push({ name: c.care_support_name, code: c.care_support_code, units: c.units, count: 1 });
    if (c.initial_addition && c.initial_addition_units > 0)
      addLines.push({ name: "初回加算", code: "434000", units: c.initial_addition_units, count: 1 });
    if (c.tokutei_kassan_units > 0)
      addLines.push({ name: `特定事業所加算(${c.tokutei_kassan_type})`, code: "436132", units: c.tokutei_kassan_units, count: 1 });
    if (c.medical_coop_kassan)
      addLines.push({ name: "特定事業所医療介護連携加算", code: "436135", units: c.medical_coop_kassan_units ?? 125, count: 1 });
    if (c.hospital_coordination)
      addLines.push({ name: "入院時情報連携加算", code: "434001", units: c.hospital_coordination_units, count: 1 });
    if (c.discharge_addition)
      addLines.push({ name: "退院・退所加算", code: "434002", units: c.discharge_addition_units, count: 1 });
    if (c.medical_coordination)
      addLines.push({ name: "通院時情報連携加算", code: "434050", units: c.medical_coordination_units ?? 50, count: 1 });
    if (c.terminal_care)
      addLines.push({ name: "ターミナルケアマネジメント加算", code: "434400", units: c.terminal_care_units ?? 400, count: 1 });
    if (c.emergency_conference)
      addLines.push({ name: "緊急時等居宅カンファレンス加算", code: "434200", units: c.emergency_conference_units ?? 200, count: 1 });
    const totalUnits = addLines.reduce((s, l) => s + l.units * l.count, 0);
    return { lines: addLines, totalUnits, totalAmount: c.total_amount, insuranceAmount: c.insurance_amount, unitPrice: c.unit_price };
  }, [claims]);

  const { era, year, month } = toWarekiYM(billingMonth);

  return (
    <>
      <style>{`
        @media print {
          body > * { display: none !important; }
          #billing-form-print, #billing-form-print * { visibility: visible !important; }
          #billing-form-print {
            position: fixed; inset: 0; background: white;
            font-family: "MS Mincho","游明朝","Hiragino Mincho ProN",serif;
          }
          @page { size: A4 portrait; margin: 8mm; }
          .no-print { display: none !important; }
        }
        @media screen { #billing-form-print { display: none; } }
      `}</style>

      <div className="flex h-full -m-6">
        <UserSidebar selectedUserId={selectedUserId} onSelectUser={setSelectedUserId} />
        <div className="flex-1 overflow-y-auto p-6 no-print">
          <div className="space-y-5">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="text-blue-600" size={24} />
                <h1 className="text-xl font-bold text-gray-900">介護給付費 明細書・請求書</h1>
              </div>
              <div className="flex items-center gap-2">
                <div className="inline-flex items-center gap-1">
                  <button
                    onClick={() => {
                      const [y, m] = billingMonth.split("-").map(Number);
                      const d = new Date(y, m - 2, 1);
                      setBillingMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
                    }}
                    className="rounded-lg border px-2 py-2 text-gray-600 hover:bg-gray-50"
                  >
                    ‹
                  </button>
                  <input
                    type="month"
                    value={billingMonth}
                    onChange={(e) => setBillingMonth(e.target.value)}
                    className="rounded-lg border px-3 py-2 text-sm"
                  />
                  <button
                    onClick={() => {
                      const [y, m] = billingMonth.split("-").map(Number);
                      const d = new Date(y, m, 1);
                      setBillingMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
                    }}
                    className="rounded-lg border px-2 py-2 text-gray-600 hover:bg-gray-50"
                  >
                    ›
                  </button>
                </div>
                <button
                  onClick={() => window.print()}
                  className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
                >
                  <Printer size={14} />
                  印刷
                </button>
              </div>
            </div>

            {/* Tab selector */}
            <div className="flex gap-1 border-b">
              {([
                { id: "meisai" as const, label: "介護給付費明細書（様式第七）" },
                { id: "seikyu" as const, label: "介護給付費請求書" },
              ]).map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                    activeTab === tab.id
                      ? "border-blue-600 text-blue-700"
                      : "border-transparent text-gray-500 hover:text-gray-700"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Content */}
            {loading ? (
              <div className="flex justify-center py-16">
                <Loader2 size={24} className="animate-spin text-blue-500" />
              </div>
            ) : activeTab === "meisai" ? (
              /* ── 明細書 ── */
              !selectedUserId ? (
                <div className="rounded-lg border bg-white py-16 text-center text-sm text-gray-500">
                  左の利用者一覧から利用者を選択してください
                </div>
              ) : !meisaiDetail ? (
                <div className="rounded-lg border bg-white py-16 text-center text-sm text-gray-500">
                  {billingMonth} の確定済みレセプトがありません
                </div>
              ) : (
                <div className="rounded-lg border-2 border-indigo-200 bg-white shadow-md">
                  <div className="border-b border-indigo-100 bg-indigo-50 px-4 py-2 flex items-center justify-between">
                    <span className="text-sm font-semibold text-indigo-700">
                      📄 介護給付費明細書 — {userInfo?.name} 様 — {era}{year}年{month}月分
                    </span>
                  </div>
                  <div className="p-4 overflow-x-auto" style={{ fontFamily: '"MS Mincho","游明朝",serif' }}>
                    <MeisaiForm
                      providerNumber={office?.provider_number ?? ""}
                      officeName={office?.office_name ?? ""}
                      officeAddress={office?.address ?? ""}
                      officePhone={office?.phone ?? ""}
                      postalCode={office?.postal_code ?? ""}
                      insurerNumber={certInfo?.insurer_number ?? ""}
                      unitPrice={meisaiDetail.unitPrice}
                      billingMonth={billingMonth}
                      person1={{
                        insuredNumber: certInfo?.insured_number ?? "",
                        userName: userInfo?.name ?? "",
                        userKana: userInfo?.name_kana ?? "",
                        birthDate: userInfo?.birth_date ?? "",
                        gender: userInfo?.gender ?? "",
                        careLevel: certInfo?.care_level ?? "",
                        certStart: certInfo?.start_date ?? "",
                        certEnd: certInfo?.end_date ?? "",
                        lines: meisaiDetail.lines.map((l) => ({ ...l, serviceUnits: l.units * l.count })),
                        totalServiceUnits: meisaiDetail.totalUnits,
                        claimAmount: meisaiDetail.insuranceAmount,
                      }}
                      person2={null}
                    />
                  </div>
                </div>
              )
            ) : (
              /* ── 請求書 ── */
              <div className="rounded-lg border-2 border-green-200 bg-white shadow-md">
                <div className="border-b border-green-100 bg-green-50 px-4 py-2">
                  <span className="text-sm font-semibold text-green-700">
                    📋 介護給付費請求書 — {era}{year}年{month}月分 — {allClaims.length}件
                  </span>
                </div>
                <div className="p-4 overflow-x-auto" style={{ fontFamily: '"MS Mincho","游明朝",serif' }}>
                  <SeikyuForm
                    providerNumber={office?.provider_number ?? ""}
                    officeName={office?.office_name ?? ""}
                    officeAddress={office?.address ?? ""}
                    officePhone={office?.phone ?? ""}
                    postalCode={office?.postal_code ?? ""}
                    billingMonth={billingMonth}
                    totalCount={seikyuSummary.totalCount}
                    totalUnits={seikyuSummary.grandUnits}
                    totalAmount={seikyuSummary.totalAmount}
                    insuranceAmount={seikyuSummary.insuranceAmount}
                    userCopay={seikyuSummary.userCopay}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Print area */}
      <div id="billing-form-print" style={{ padding: "8mm" }}>
        {activeTab === "meisai" && meisaiDetail && (
          <MeisaiForm
            providerNumber={office?.provider_number ?? ""}
            officeName={office?.office_name ?? ""}
            officeAddress={office?.address ?? ""}
            officePhone={office?.phone ?? ""}
            postalCode={office?.postal_code ?? ""}
            insurerNumber={certInfo?.insurer_number ?? ""}
            unitPrice={meisaiDetail.unitPrice}
            billingMonth={billingMonth}
            person1={{
              insuredNumber: certInfo?.insured_number ?? "",
              userName: userInfo?.name ?? "",
              userKana: userInfo?.name_kana ?? "",
              birthDate: userInfo?.birth_date ?? "",
              gender: userInfo?.gender ?? "",
              careLevel: certInfo?.care_level ?? "",
              certStart: certInfo?.start_date ?? "",
              certEnd: certInfo?.end_date ?? "",
              lines: meisaiDetail.lines.map((l) => ({ ...l, serviceUnits: l.units * l.count })),
              totalServiceUnits: meisaiDetail.totalUnits,
              claimAmount: meisaiDetail.insuranceAmount,
            }}
            person2={null}
          />
        )}
        {activeTab === "seikyu" && (
          <SeikyuForm
            providerNumber={office?.provider_number ?? ""}
            officeName={office?.office_name ?? ""}
            officeAddress={office?.address ?? ""}
            officePhone={office?.phone ?? ""}
            postalCode={office?.postal_code ?? ""}
            billingMonth={billingMonth}
            totalCount={seikyuSummary.totalCount}
            totalUnits={seikyuSummary.grandUnits}
            totalAmount={seikyuSummary.totalAmount}
            insuranceAmount={seikyuSummary.insuranceAmount}
            userCopay={seikyuSummary.userCopay}
          />
        )}
      </div>
    </>
  );
}

// ─── 旧コンポーネント（_meisai.tsx / _seikyu.tsx に移行済み・削除予定）────────
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _DEPRECATED_MeisaiPreview({
  office,
  user,
  cert,
  detail,
  billingMonth,
}: {
  office: OfficeInfo | null;
  user: UserInfo | null;
  cert: CertInfo | null;
  detail: { lines: { name: string; code: string; units: number; count: number }[]; totalUnits: number; totalAmount: number; insuranceAmount: number; unitPrice: number };
  billingMonth: string;
}) {
  const B = "1px solid #000";
  const cell: React.CSSProperties = { border: B, padding: "1px 3px", fontSize: "8pt", verticalAlign: "middle" };
  const th: React.CSSProperties = { ...cell, fontWeight: "bold", textAlign: "center", backgroundColor: "#f5f5f5" };
  const { era, year, month } = toWarekiYM(billingMonth);

  const birthWareki = user?.birth_date ? toWareki(user.birth_date) : "";
  const certStart = cert?.start_date ? toWareki(cert.start_date) : "";
  const certEnd = cert?.end_date ? toWareki(cert.end_date) : "";

  return (
    <div style={{ fontSize: "8pt", color: "#000", maxWidth: "190mm" }}>
      <div style={{ textAlign: "center", fontWeight: "bold", fontSize: "11pt", marginBottom: "4px", letterSpacing: "0.2em" }}>
        居宅サービス・地域密着型サービス介護給付費明細書
      </div>

      {/* 上段: 被保険者情報 + 事業所情報 */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "4px" }}>
        <tbody>
          <tr>
            <td style={{ ...th, width: "12%" }}>被保険者番号</td>
            <td style={{ ...cell, width: "22%", fontFamily: "monospace", letterSpacing: "2px" }}>{cert?.insured_number ?? ""}</td>
            <td style={{ ...th, width: "12%" }}>事業所番号</td>
            <td style={{ ...cell, width: "22%", fontFamily: "monospace", letterSpacing: "2px" }}>{office?.provider_number ?? ""}</td>
          </tr>
          <tr>
            <td style={th}>氏名</td>
            <td style={{ ...cell, fontWeight: "bold" }}>{user?.name ?? ""}</td>
            <td style={th}>事業所名称</td>
            <td style={cell}>{office?.office_name ?? ""}</td>
          </tr>
          <tr>
            <td style={th}>生年月日</td>
            <td style={cell}>{birthWareki}　{user?.gender === "男" ? "男" : "女"}</td>
            <td style={th}>所在地</td>
            <td style={cell}>{office?.address ?? ""}</td>
          </tr>
          <tr>
            <td style={th}>要介護状態区分</td>
            <td style={cell}>{cert?.care_level ?? ""}</td>
            <td style={th}>連絡先</td>
            <td style={cell}>{office?.phone ?? ""}</td>
          </tr>
          <tr>
            <td style={th}>認定有効期間</td>
            <td style={cell}>{certStart} ～ {certEnd}</td>
            <td style={th}>保険者番号</td>
            <td style={{ ...cell, fontFamily: "monospace" }}>{cert?.insurer_number ?? ""}</td>
          </tr>
        </tbody>
      </table>

      <div style={{ textAlign: "right", fontSize: "8pt", marginBottom: "4px" }}>
        {era}{year}年{month}月分
      </div>

      {/* サービス明細 */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "4px" }}>
        <thead>
          <tr>
            <th style={{ ...th, width: "30%" }}>サービス内容</th>
            <th style={{ ...th, width: "15%" }}>サービスコード</th>
            <th style={{ ...th, width: "10%" }}>単位数</th>
            <th style={{ ...th, width: "8%" }}>回数</th>
            <th style={{ ...th, width: "12%" }}>サービス単位数</th>
            <th style={{ ...th, width: "12%" }}>公費対象単位数</th>
            <th style={{ ...th, width: "13%" }}>摘要</th>
          </tr>
        </thead>
        <tbody>
          {detail.lines.map((line, i) => (
            <tr key={i}>
              <td style={cell}>{line.name}</td>
              <td style={{ ...cell, fontFamily: "monospace", textAlign: "center" }}>{line.code}</td>
              <td style={{ ...cell, textAlign: "right" }}>{line.units.toLocaleString()}</td>
              <td style={{ ...cell, textAlign: "right" }}>{line.count}</td>
              <td style={{ ...cell, textAlign: "right" }}>{(line.units * line.count).toLocaleString()}</td>
              <td style={{ ...cell, textAlign: "right" }}></td>
              <td style={cell}></td>
            </tr>
          ))}
          {/* 空行で最低6行に */}
          {Array.from({ length: Math.max(0, 6 - detail.lines.length) }).map((_, i) => (
            <tr key={`e${i}`}>
              <td style={cell}>&nbsp;</td>
              <td style={cell}></td>
              <td style={cell}></td>
              <td style={cell}></td>
              <td style={cell}></td>
              <td style={cell}></td>
              <td style={cell}></td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* 請求集計 */}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          <tr>
            <td style={{ ...th, width: "20%" }}>④計画単位数</td>
            <td style={{ ...cell, width: "15%", textAlign: "right" }}>{detail.totalUnits.toLocaleString()}</td>
            <td style={{ ...th, width: "20%" }}>給付率(/100)</td>
            <td style={{ ...cell, width: "15%", textAlign: "right" }}>保険　100</td>
          </tr>
          <tr>
            <td style={th}>⑤限度額管理対象単位数</td>
            <td style={{ ...cell, textAlign: "right" }}>0</td>
            <td style={th}>⑨単位数単価</td>
            <td style={{ ...cell, textAlign: "right" }}>{detail.unitPrice.toFixed(2)} 円/単位</td>
          </tr>
          <tr>
            <td style={th}>⑥限度額管理対象外単位数</td>
            <td style={{ ...cell, textAlign: "right" }}>{detail.totalUnits.toLocaleString()}</td>
            <td style={{ ...th, fontWeight: "bold" }}>⑩保険請求額</td>
            <td style={{ ...cell, textAlign: "right", fontWeight: "bold", color: "#1d4ed8" }}>{detail.insuranceAmount.toLocaleString()} 円</td>
          </tr>
          <tr>
            <td style={th}>⑦給付単位数(⑤+⑥)</td>
            <td style={{ ...cell, textAlign: "right" }}>{detail.totalUnits.toLocaleString()}</td>
            <td style={th}>⑪利用者負担額</td>
            <td style={{ ...cell, textAlign: "right" }}>0 円</td>
          </tr>
          <tr>
            <td style={th}>⑧費用合計(⑦×⑨)</td>
            <td style={{ ...cell, textAlign: "right" }}>{detail.totalAmount.toLocaleString()} 円</td>
            <td style={th}>⑫公費請求額</td>
            <td style={{ ...cell, textAlign: "right" }}>0 円</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ─── 介護給付費請求書 ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _DEPRECATED_SeikyuPreview({
  office,
  summary,
  billingMonth,
}: {
  office: OfficeInfo | null;
  summary: { totalCount: number; totalUnits: number; addUnits: number; grandUnits: number; totalAmount: number; insuranceAmount: number; userCopay: number };
  billingMonth: string;
}) {
  const B = "1px solid #000";
  const cell: React.CSSProperties = { border: B, padding: "2px 4px", fontSize: "8pt", verticalAlign: "middle" };
  const th: React.CSSProperties = { ...cell, fontWeight: "bold", textAlign: "center", backgroundColor: "#f5f5f5" };
  const { era, year, month } = toWarekiYM(billingMonth);

  return (
    <div style={{ fontSize: "8pt", color: "#000", maxWidth: "190mm" }}>
      <div style={{ textAlign: "right", fontSize: "9pt", marginBottom: "4px" }}>
        {era}{year}年{month}月分
      </div>
      <div style={{ textAlign: "center", fontWeight: "bold", fontSize: "13pt", marginBottom: "8px", letterSpacing: "0.3em" }}>
        介護給付費請求書
      </div>

      {/* 事業所情報 */}
      <table style={{ width: "60%", borderCollapse: "collapse", marginBottom: "8px", marginLeft: "auto" }}>
        <tbody>
          <tr>
            <td style={{ ...th, width: "30%" }}>事業所番号</td>
            <td style={{ ...cell, fontFamily: "monospace", letterSpacing: "2px" }}>{office?.provider_number ?? ""}</td>
          </tr>
          <tr>
            <td style={th}>名称</td>
            <td style={cell}>{office?.office_name ?? ""}</td>
          </tr>
          <tr>
            <td style={th}>所在地</td>
            <td style={cell}>〒{office?.postal_code ?? ""}　{office?.address ?? ""}</td>
          </tr>
          <tr>
            <td style={th}>連絡先</td>
            <td style={cell}>{office?.phone ?? ""}</td>
          </tr>
        </tbody>
      </table>

      <div style={{ fontSize: "9pt", marginBottom: "6px" }}>
        保険者（別記）殿<br />
        下記のとおり請求します。　{era}{year}年{month}月
      </div>

      {/* 保険請求 */}
      <div style={{ fontWeight: "bold", fontSize: "9pt", marginBottom: "2px" }}>保険請求</div>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "8px" }}>
        <thead>
          <tr>
            <th style={th}>区分</th>
            <th style={th}>件数</th>
            <th style={th}>単位数・点数</th>
            <th style={th}>費用合計</th>
            <th style={th}>保険請求額</th>
            <th style={th}>公費請求額</th>
            <th style={th}>利用者負担</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ ...cell, fontSize: "7pt" }}>
              居宅介護支援・<br />介護予防支援
            </td>
            <td style={{ ...cell, textAlign: "right" }}>{summary.totalCount}</td>
            <td style={{ ...cell, textAlign: "right" }}>{summary.grandUnits.toLocaleString()}</td>
            <td style={{ ...cell, textAlign: "right" }}>{summary.totalAmount.toLocaleString()}</td>
            <td style={{ ...cell, textAlign: "right", fontWeight: "bold", color: "#1d4ed8" }}>{summary.insuranceAmount.toLocaleString()}</td>
            <td style={{ ...cell, textAlign: "right" }}>0</td>
            <td style={{ ...cell, textAlign: "right" }}>0</td>
          </tr>
          <tr style={{ fontWeight: "bold", backgroundColor: "#f0f0f0" }}>
            <td style={{ ...cell, textAlign: "center", fontWeight: "bold" }}>合計</td>
            <td style={{ ...cell, textAlign: "right" }}>{summary.totalCount}</td>
            <td style={{ ...cell, textAlign: "right" }}>{summary.grandUnits.toLocaleString()}</td>
            <td style={{ ...cell, textAlign: "right" }}>{summary.totalAmount.toLocaleString()}</td>
            <td style={{ ...cell, textAlign: "right", color: "#1d4ed8" }}>{summary.insuranceAmount.toLocaleString()}</td>
            <td style={{ ...cell, textAlign: "right" }}>0</td>
            <td style={{ ...cell, textAlign: "right" }}>0</td>
          </tr>
        </tbody>
      </table>

      {/* 区分別 */}
      <div style={{ fontWeight: "bold", fontSize: "9pt", marginBottom: "2px" }}>区分</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={th} colSpan={2}>区分</th>
            <th style={th} colSpan={3}>サービス費用</th>
          </tr>
          <tr>
            <th style={{ ...th, width: "8%" }}></th>
            <th style={{ ...th, width: "30%" }}></th>
            <th style={{ ...th, width: "12%" }}>件数</th>
            <th style={{ ...th, width: "15%" }}>単位数・点数</th>
            <th style={{ ...th, width: "15%" }}>費用合計</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ ...cell, textAlign: "center" }}>43</td>
            <td style={cell}>居宅介護支援</td>
            <td style={{ ...cell, textAlign: "right" }}>{summary.totalCount}</td>
            <td style={{ ...cell, textAlign: "right" }}>{summary.grandUnits.toLocaleString()}</td>
            <td style={{ ...cell, textAlign: "right" }}>{summary.totalAmount.toLocaleString()}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
