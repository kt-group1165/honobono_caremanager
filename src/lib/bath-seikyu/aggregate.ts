/**
 * 訪問入浴介護 請求集計 (v2: visit-seikyu と同等の制度対応)
 *
 * データフロー:
 *   kaigo_bath_visit_records (actual=true, confirmed/submitted)
 *     × kaigo_service_codes (service_code → units, 対象月世代)
 *     × client_insurance_records (認定=保険者/被保険者番号/要介護度/負担割合/限度額/居宅事業所, 月次解決)
 *     × client_kohi_records (公費)
 *     × bath_monthly_plan_units (計画単位数)
 *     × offices (地域単価 / 処遇改善加算)
 *   → 利用者ごとに UserSeikyuRow (visit-seikyu と同型 = build.ts に直結可)
 *
 * 制度対応(v2で追加):
 *   - copay_rate 正規化(≥1は/10)・認定の月次解決(月遅れ再請求に追従)
 *   - 居宅サービス計画作成事業所番号(careOfficeNumber)を認定から解決 → 様式第二 項20
 *   - 区分支給限度基準の超過→全額自費(selfPayAmount)分離
 *   - 公費(生保/公費単独=全額振替、部分公費=保険+本人負担で振替しない)
 *   - 回単位加算: 初回(124113 200/月 対象外)・認知症専門ケアⅠ/Ⅱ(126133/126134 /回)・中山間(128110 所定×5%)
 *   - 処遇改善(月次%)
 *   - 虐防/業未の事業所減算は別コード(121131等)で記録側が選択する前提(runtime減算しない)
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { validInMonth, monthRange } from "@/lib/service-code-valid";
import { resolveCertForMonth } from "@/lib/cert-for-month";
import { resolveKohiForMonth, kohiHobetsuLabel } from "@/lib/kohi";
import type { MonthlySeikyuResult, UserSeikyuRow, SeikyuDetailLine } from "@/lib/visit-seikyu/aggregate";

type BathRec = {
  client_id: string;
  visit_date: string;
  service_code: string | null;
  addon_shokai: boolean | null;
  addon_ninchi: "I" | "II" | null;
  addon_chuusankan: boolean | null;
};
type Cl = { id: string; name: string | null; furigana: string | null; user_number: string | null; gender: string | null; birth_date: string | null };

// 回単位加算コード (種類12)
const CODE_SHOKAI = "124113"; // 訪問入浴初回加算 200単位/月 (限度額管理対象外)
const CODE_NINCHI = { I: "126133", II: "126134" } as const; // 認知症専門ケア加算Ⅰ3/Ⅱ4 (/回)
const CODE_CHUUSANKAN = "128110"; // 中山間地域等提供加算 = 所定単位 × 5%

export async function aggregateBathVisitSeikyu(
  supabase: SupabaseClient,
  opts: { officeId: string | null; tenantId: string; year: number; month: number; unitPrice?: number; appliedFormulaCodes?: string[] },
): Promise<MonthlySeikyuResult> {
  const { year, month } = opts;
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  const { monthStart, monthEnd } = monthRange(year, month);
  const unitPrice = opts.unitPrice ?? 10;
  const unitPrice100 = Math.round(unitPrice * 100);
  const warnings: string[] = [];

  // 1) 入浴実績 (実績=actual, 確定/請求済)
  let q = supabase
    .from("kaigo_bath_visit_records")
    .select("client_id, visit_date, service_code, addon_shokai, addon_ninchi, addon_chuusankan")
    .gte("visit_date", monthStart)
    .lte("visit_date", monthEnd)
    .eq("actual", true)
    .in("status", ["confirmed", "submitted"]);
  if (opts.officeId) q = q.eq("office_id", opts.officeId);
  const { data: recData, error: recErr } = await q;
  if (recErr) throw recErr;
  const records = (recData ?? []) as BathRec[];
  if (records.length === 0) return { rows: [], month: monthKey, recordCount: 0, warnings };

  const clientIds = Array.from(new Set(records.map((r) => r.client_id)));

  // 2) サービスコード → 単位数 (基本 + 回単位加算コード, 対象月世代)
  const baseCodes = Array.from(new Set(records.map((r) => r.service_code).filter(Boolean))) as string[];
  const codeSet = Array.from(new Set([...baseCodes, CODE_SHOKAI, CODE_NINCHI.I, CODE_NINCHI.II]));
  const codeMap = new Map<string, { units: number; name: string; short: string | null }>();
  {
    const { data, error } = await validInMonth(
      supabase.from("kaigo_service_codes").select("service_code, service_name, short_name, units").in("service_code", codeSet).eq("system", "介護"),
      year,
      month,
    );
    if (error) throw error;
    for (const c of (data ?? []) as { service_code: string; service_name: string; short_name: string | null; units: number }[]) {
      if (!codeMap.has(c.service_code)) codeMap.set(c.service_code, { units: c.units, name: c.service_name, short: c.short_name });
    }
  }

  // 3) 認定(月次解決) / 公費 / 計画単位数 / 利用者
  const certByClient = await resolveCertForMonth(supabase, clientIds, year, month);
  const kohiRes = await resolveKohiForMonth(supabase, clientIds, year, month);
  const planByClient = new Map<string, number>();
  {
    const { data } = await supabase
      .from("bath_monthly_plan_units")
      .select("client_id, planned_units")
      .eq("target_month", `${monthKey}-01`);
    for (const p of (data ?? []) as { client_id: string; planned_units: number | null }[]) {
      if (p.planned_units != null) planByClient.set(p.client_id, p.planned_units);
    }
  }
  const clientMap = new Map<string, Cl>();
  {
    const { data, error } = await supabase.from("clients").select("id, name, furigana, user_number, gender, birth_date").in("id", clientIds);
    if (error) throw error;
    for (const c of (data ?? []) as Cl[]) clientMap.set(c.id, c);
  }

  // 4) 処遇改善加算 formula (月次%)
  let addonNum = 0;
  let addonDen = 1;
  let addonCode: string | null = null;
  let addonLabel: string | null = null;
  const formulaCodes = opts.appliedFormulaCodes ?? [];
  if (formulaCodes.length) {
    const { data } = await validInMonth(
      supabase.from("kaigo_service_codes").select("service_code, service_name, formula").in("service_code", formulaCodes).eq("system", "介護").not("formula", "is", null),
      year,
      month,
    );
    for (const r of (data ?? []) as { service_code: string; service_name: string; formula: { type?: string; numerator?: number; denominator?: number } | null }[]) {
      const f = r.formula;
      if (f?.type === "monthly_aggregate" && f.numerator && f.denominator) {
        addonNum = f.numerator; addonDen = f.denominator; addonCode = r.service_code; addonLabel = r.service_name; break;
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
    const cert = certByClient.get(clientId) ?? null;
    const name = cl?.name ?? "(利用者不明)";
    if (cert?.isFallback) warnings.push(`${name}: 対象月(${monthKey})に有効な認定が無く最新の認定で集計しています — 認定有効期間を確認してください`);

    // 負担割合の正規化 (1/2/3 → 0.1/0.2/0.3)
    const copayRaw = cert?.copay_rate != null ? Number(cert.copay_rate) : null;
    const copay = copayRaw == null || !Number.isFinite(copayRaw) || copayRaw <= 0 ? 0.1 : copayRaw >= 1 ? Math.min(copayRaw / 10, 1) : copayRaw;
    const limitAmount = cert?.service_limit_amount != null && Number(cert.service_limit_amount) > 0 ? Number(cert.service_limit_amount) : null;

    // 明細: 基本(service_code ごと)
    const detailMap = new Map<string, SeikyuDetailLine>();
    for (const r of recs) {
      const code = r.service_code;
      if (!code) { warnings.push(`${name}: サービスコード未設定の記録があります`); continue; }
      const info = codeMap.get(code);
      if (!info) { warnings.push(`${name}: コード${code}が対象月マスタに未一致`); continue; }
      const ex = detailMap.get(code);
      if (ex) { ex.count += 1; ex.units += info.units; }
      else detailMap.set(code, { service_type: info.name, short_name: info.short, service_code: code, unit_per: info.units, count: 1, units: info.units });
    }
    const details = Array.from(detailMap.values());
    const serviceBaseUnits = details.reduce((s, d) => s + d.units, 0); // 所定単位(基本のみ)。中山間%の母数
    let grossBaseUnits = serviceBaseUnits;
    let shokaiUnits = 0; // 限度額管理対象外(初回)

    // 回単位加算
    const pushAddon = (code: string, count: number, taishougai: boolean) => {
      if (count <= 0) return;
      const info = codeMap.get(code);
      if (!info) { warnings.push(`${name}: 加算コード${code}が対象月マスタに未一致`); return; }
      const units = info.units * count;
      grossBaseUnits += units;
      if (taishougai) shokaiUnits += units;
      details.push({ service_type: info.name, short_name: info.short, service_code: code, unit_per: info.units, count, units });
    };
    // 初回加算: 月1回(いずれかの記録でON)。対象外
    if (recs.some((r) => r.addon_shokai)) pushAddon(CODE_SHOKAI, 1, true);
    // 認知症専門ケア: 記録(回)ごと。Ⅰ/Ⅱ別に集計
    const ninchiI = recs.filter((r) => r.addon_ninchi === "I").length;
    const ninchiII = recs.filter((r) => r.addon_ninchi === "II").length;
    if (ninchiI > 0) pushAddon(CODE_NINCHI.I, ninchiI, false);
    if (ninchiII > 0) pushAddon(CODE_NINCHI.II, ninchiII, false);
    // 中山間地域等提供加算 = 所定単位 × 5% (いずれかの記録でON)
    if (recs.some((r) => r.addon_chuusankan) && serviceBaseUnits > 0) {
      const cu = Math.round(serviceBaseUnits * 0.05);
      const info = codeMap.get(CODE_CHUUSANKAN);
      grossBaseUnits += cu;
      details.push({ service_type: info?.name ?? "訪問入浴中山間地域等提供加算", short_name: info?.short ?? null, service_code: CODE_CHUUSANKAN, unit_per: cu, count: 1, units: cu });
    }

    details.sort((a, b) => b.units - a.units);

    // 区分支給限度基準の超過→全額自費
    const planUnits = planByClient.get(clientId) ?? null;
    const limitUnits = planUnits ?? limitAmount;
    const managedUnits = grossBaseUnits - shokaiUnits;
    const autoOver = limitUnits != null ? Math.max(0, managedUnits - limitUnits) : 0;
    const overUnits = Math.min(autoOver, managedUnits);
    const baseUnits = grossBaseUnits - overUnits;
    const addonUnits = addonNum > 0 ? Math.round((baseUnits * addonNum) / addonDen) : 0;
    const kanriTaishougaiUnits = addonUnits + shokaiUnits;
    const totalUnits = baseUnits + addonUnits;
    const totalAmount = Math.floor((totalUnits * unitPrice100) / 100);
    const overAmount = Math.floor((overUnits * unitPrice100) / 100);

    // 公費: 生保(法別12)/公費単独=全額振替。部分公費(他法別)=振替しない(保険+本人負担)
    const kohiTandoku = /^[Hh]/.test((cert?.insured_number ?? "").trim());
    const kohi = kohiRes.byClient.get(clientId) ?? null;
    const isSeiho = kohiTandoku || kohi?.hobetsu === "12";
    const copayX10 = Math.min(10, Math.max(0, Math.round(copay * 10)));
    const insuranceAmount = kohiTandoku ? 0 : Math.floor((totalAmount * (10 - copayX10)) / 10);
    const publicExpense = kohi ? kohiHobetsuLabel(kohi.hobetsu) : kohiTandoku ? "公費単独 (生活保護 10割)" : null;
    if (kohi && !isSeiho) warnings.push(`${name}: 公費(${kohiHobetsuLabel(kohi.hobetsu)})は部分公費のため本人負担を残し公費振替しません(要確認)`);
    const kohiAmount = kohiTandoku ? totalAmount : isSeiho ? totalAmount - insuranceAmount : null;
    const userAmount = isSeiho ? 0 : totalAmount - insuranceAmount;

    rows.push({
      user_id: clientId,
      user_name: name,
      user_name_kana: cl?.furigana ?? null,
      user_number: cl?.user_number ?? null,
      insurer_number: cert?.insurer_number ?? null,
      insurer_name: cert?.insurer_name?.trim() || null,
      insured_number: cert?.insured_number ?? null,
      care_level: cert?.care_level ?? null,
      copay_rate: copay,
      details,
      grossBaseUnits,
      limitUnits,
      planUnits,
      overUnits,
      overSource: "auto",
      overAmount,
      selfPayAmount: overAmount,
      baseUnits,
      addonUnits,
      kanriTaishougaiUnits,
      addonLabel,
      totalUnits,
      unitPrice,
      totalAmount,
      insuranceAmount,
      userAmount,
      publicExpense,
      kohiTandoku,
      kohiHobetsu: kohi?.hobetsu ?? (kohiTandoku ? "12" : null),
      kohiFutanshaNumber: kohi?.futansha ?? null,
      kohiJukyushaNumber: kohi?.jukyusha ?? null,
      kohiUnits: isSeiho ? totalUnits : null,
      kohiAmount,
      addonCode,
      birthDate: cl?.birth_date ?? null,
      gender: cl?.gender ?? null,
      certStart: cert?.certification_start_date ?? null,
      certEnd: cert?.certification_end_date ?? null,
      careOfficeNumber: cert?.care_office_number ?? null,
      careOfficeName: cert?.care_office_name ?? null,
      serviceDays: new Set(recs.map((r) => r.visit_date)).size,
    });
  }
  rows.sort((a, b) => (a.user_name_kana ?? a.user_name).localeCompare(b.user_name_kana ?? b.user_name, "ja"));

  return { rows, month: monthKey, recordCount: records.length, warnings: Array.from(new Set(warnings)) };
}
