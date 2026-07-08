/**
 * 訪問入浴介護 請求集計 (v1)
 *
 * データフロー:
 *   kaigo_bath_visit_records (status='confirmed'|'submitted')
 *     × kaigo_service_codes (service_code → units, 対象月世代)
 *     × clients (氏名/保険者番号/被保険者番号/要介護度/負担割合/生年月日 等)
 *     × offices (地域区分単価 / 処遇改善加算コード)
 *   → 利用者ごとに 1 行 (UserSeikyuRow) を返す → そのまま build.ts (buildKokuhoDensou) に渡せる
 *
 * v1 の範囲: 基本(全身/部分×職員のみ) + 処遇改善(月次%)。
 *   未対応(v2): 初回加算/認知症専門ケア/中山間 の回単位加算、区分支給限度超過、公費。
 *   → aggregateMonthlyVisitSeikyu と同じ UserSeikyuRow 形状なので後から拡張しやすい。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { validInMonth, monthRange } from "@/lib/service-code-valid";
import type { MonthlySeikyuResult, UserSeikyuRow, SeikyuDetailLine } from "@/lib/visit-seikyu/aggregate";

type BathRec = { client_id: string; visit_date: string; service_code: string | null; status: string };
type Cl = {
  id: string;
  name: string | null;
  furigana: string | null;
  user_number: string | null;
  insured_number: string | null;
  insurer_number: string | null;
  care_level: string | null;
  copay_rate: number | null;
  birth_date: string | null;
  gender: string | null;
  certification_start_date: string | null;
  certification_end_date: string | null;
};

export async function aggregateBathVisitSeikyu(
  supabase: SupabaseClient,
  opts: {
    officeId: string | null;
    tenantId: string;
    year: number;
    month: number; // 1-12
    unitPrice?: number;
    appliedFormulaCodes?: string[];
  },
): Promise<MonthlySeikyuResult> {
  const { year, month } = opts;
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  const { monthStart, monthEnd } = monthRange(year, month);
  const unitPrice = opts.unitPrice ?? 10;
  const warnings: string[] = [];

  // 1) 入浴実績
  let q = supabase
    .from("kaigo_bath_visit_records")
    .select("client_id, visit_date, service_code, status")
    .gte("visit_date", monthStart)
    .lte("visit_date", monthEnd)
    .eq("actual", true) // 実績のみ請求対象 (予定のみの行は除外)
    .in("status", ["confirmed", "submitted"]);
  if (opts.officeId) q = q.eq("office_id", opts.officeId);
  const { data: recData, error: recErr } = await q;
  if (recErr) throw recErr;
  const records = (recData ?? []) as BathRec[];
  if (records.length === 0) return { rows: [], month: monthKey, recordCount: 0, warnings };

  // 2) サービスコード → 単位数 (対象月世代)
  const codes = Array.from(new Set(records.map((r) => r.service_code).filter(Boolean))) as string[];
  const codeMap = new Map<string, { units: number; name: string; short: string | null }>();
  if (codes.length) {
    const { data: cData, error: cErr } = await validInMonth(
      supabase
        .from("kaigo_service_codes")
        .select("service_code, service_name, short_name, units")
        .in("service_code", codes)
        .eq("system", "介護"),
      year,
      month,
    );
    if (cErr) throw cErr;
    for (const c of (cData ?? []) as { service_code: string; service_name: string; short_name: string | null; units: number }[]) {
      if (!codeMap.has(c.service_code)) codeMap.set(c.service_code, { units: c.units, name: c.service_name, short: c.short_name });
    }
  }

  // 3) 利用者情報
  const clientIds = Array.from(new Set(records.map((r) => r.client_id)));
  const { data: clData, error: clErr } = await supabase
    .from("clients")
    .select("id, name, furigana, user_number, insured_number, insurer_number, care_level, copay_rate, birth_date, gender, certification_start_date, certification_end_date")
    .in("id", clientIds);
  if (clErr) throw clErr;
  const clientMap = new Map<string, Cl>();
  for (const c of (clData ?? []) as Cl[]) clientMap.set(c.id, c);

  // 4) 処遇改善加算 formula (月次%)
  let addonNum = 0;
  let addonDen = 1;
  let addonCode: string | null = null;
  let addonLabel: string | null = null;
  const formulaCodes = opts.appliedFormulaCodes ?? [];
  if (formulaCodes.length) {
    const { data: fData } = await validInMonth(
      supabase
        .from("kaigo_service_codes")
        .select("service_code, service_name, formula")
        .in("service_code", formulaCodes)
        .eq("system", "介護")
        .not("formula", "is", null),
      year,
      month,
    );
    for (const r of (fData ?? []) as { service_code: string; service_name: string; formula: { type?: string; numerator?: number; denominator?: number } | null }[]) {
      const f = r.formula;
      if (f?.type === "monthly_aggregate" && f.numerator && f.denominator) {
        addonNum = f.numerator;
        addonDen = f.denominator;
        addonCode = r.service_code;
        addonLabel = r.service_name;
        break;
      }
    }
  }

  // 5) 利用者ごと集計
  const byClient = new Map<string, BathRec[]>();
  for (const r of records) {
    if (!byClient.has(r.client_id)) byClient.set(r.client_id, []);
    byClient.get(r.client_id)!.push(r);
  }

  const rows: UserSeikyuRow[] = [];
  for (const [clientId, recs] of byClient) {
    const cl = clientMap.get(clientId);
    const name = cl?.name ?? "(不明)";
    // 明細 (service_code ごと)
    const detailMap = new Map<string, SeikyuDetailLine>();
    for (const r of recs) {
      const code = r.service_code;
      if (!code) { warnings.push(`${name}: サービスコード未設定の記録`); continue; }
      const info = codeMap.get(code);
      if (!info) { warnings.push(`${name}: コード ${code} がマスタ未一致`); continue; }
      const ex = detailMap.get(code);
      if (ex) { ex.count += 1; ex.units += info.units; }
      else detailMap.set(code, { service_type: info.name, short_name: info.short, service_code: code, unit_per: info.units, count: 1, units: info.units });
    }
    const details = Array.from(detailMap.values());
    const baseUnits = details.reduce((s, d) => s + d.units, 0);
    const addonUnits = addonNum > 0 ? Math.round((baseUnits * addonNum) / addonDen) : 0;
    const totalUnits = baseUnits + addonUnits;
    const price100 = Math.round(unitPrice * 100);
    const totalAmount = Math.floor((totalUnits * price100) / 100);
    const copay = cl?.copay_rate ?? 0.1;
    const insuranceAmount = Math.floor((totalAmount * (10 - Math.round(copay * 10))) / 10);
    const userAmount = totalAmount - insuranceAmount;
    const serviceDays = new Set(recs.map((r) => r.visit_date)).size;

    rows.push({
      user_id: clientId,
      user_name: name,
      user_name_kana: cl?.furigana ?? null,
      user_number: cl?.user_number ?? null,
      insurer_number: cl?.insurer_number ?? null,
      insurer_name: null,
      insured_number: cl?.insured_number ?? null,
      care_level: cl?.care_level ?? null,
      copay_rate: copay,
      details,
      grossBaseUnits: baseUnits,
      limitUnits: null,
      planUnits: null,
      overUnits: 0,
      overSource: "auto",
      overAmount: 0,
      selfPayAmount: 0,
      baseUnits,
      addonUnits,
      kanriTaishougaiUnits: addonUnits,
      addonLabel,
      totalUnits,
      unitPrice,
      totalAmount,
      insuranceAmount,
      userAmount,
      publicExpense: null,
      kohiTandoku: false,
      kohiHobetsu: null,
      kohiFutanshaNumber: null,
      kohiJukyushaNumber: null,
      kohiUnits: null,
      kohiAmount: null,
      addonCode,
      birthDate: cl?.birth_date ?? null,
      gender: cl?.gender ?? null,
      certStart: cl?.certification_start_date ?? null,
      certEnd: cl?.certification_end_date ?? null,
      careOfficeNumber: null,
      careOfficeName: null,
      serviceDays,
    });
  }
  rows.sort((a, b) => (a.user_name_kana ?? a.user_name).localeCompare(b.user_name_kana ?? b.user_name, "ja"));

  return { rows, month: monthKey, recordCount: records.length, warnings: Array.from(new Set(warnings)) };
}
