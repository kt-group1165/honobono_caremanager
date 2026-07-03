/**
 * 訪問介護 請求集計 (介護請求 / 利用請求 / 国保請求 の共通ロジック)
 *
 * データフロー:
 *   kaigo_visit_schedule (status='completed' = 実績)
 *     × kaigo_service_codes (service_name → units)
 *     × clients + client_insurance_records (氏名 / 保険者番号 / 被保険者番号 / 要介護度 / 負担割合)
 *     × offices (地域区分単価 / 処遇改善加算)
 *   → 利用者ごとに 1 行の請求サマリ
 *
 * 金額計算 (介護保険の標準):
 *   総単位数 = Σ(サービス単位 × 回数) + 加算単位 (処遇改善等 = %加算)
 *   総額     = floor(総単位数 × 地域単価)
 *   利用者負担 = floor(総額 × 負担割合)   ※ copay_rate 未設定は 1 割
 *   保険請求額 = 総額 - 利用者負担
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  serviceNameVariantsAll,
  toHankakuDigits,
} from "@/lib/service-name-normalize";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SeikyuDetailLine {
  /** サービス名 (身体介護3 等) */
  service_type: string;
  /** 略称 (身3 等)。無ければ service_type */
  short_name: string | null;
  /** サービスコード 6 桁 (国保連伝送用)。マスタ未一致時 null */
  service_code: string | null;
  /** 1 回あたり単位数 */
  unit_per: number;
  /** 実績回数 */
  count: number;
  /** 小計単位数 */
  units: number;
}

export interface UserSeikyuRow {
  user_id: string;
  user_name: string;
  user_name_kana: string | null;
  insurer_number: string | null;
  insured_number: string | null;
  care_level: string | null;
  /** 負担割合 (0.1 / 0.2 / 0.3)。レコード無し時は 0.1 */
  copay_rate: number;
  /** 明細行 (サービス種類ごと) */
  details: SeikyuDetailLine[];
  /** 本体単位数 (加算前) */
  baseUnits: number;
  /** 処遇改善等 加算単位数 */
  addonUnits: number;
  /** 加算の名称 (表示用) */
  addonLabel: string | null;
  /** 総単位数 */
  totalUnits: number;
  /** 地域区分単価 (10.0 等) */
  unitPrice: number;
  /** 総額 (円) */
  totalAmount: number;
  /** 保険請求額 (円) */
  insuranceAmount: number;
  /** 利用者負担額 (円) */
  userAmount: number;
  /** 公費 (生活保護等)。client_insurance_records.public_expense。null = 公費なし */
  publicExpense: string | null;
  /** 公費対象単位数 (公費ありのとき全単位を対象とする簡易版) */
  kohiUnits: number | null;
  /** 公費請求額 (円) = 本人負担分を公費へ振替 (生保想定・本人負担 0) */
  kohiAmount: number | null;
  // ─── 国保連伝送用の追加情報 ───
  /** 加算のサービスコード (116274 等) */
  addonCode: string | null;
  /** 生年月日 (YYYY-MM-DD) */
  birthDate: string | null;
  /** 性別 (男/女 表記そのまま) */
  gender: string | null;
  /** 認定有効期間 開始 (YYYY-MM-DD) */
  certStart: string | null;
  /** 認定有効期間 終了 (YYYY-MM-DD) */
  certEnd: string | null;
  /** 担当居宅介護支援事業所の事業所番号 (10 桁)。未解決は null */
  careOfficeNumber: string | null;
  /** サービス実日数 (訪問した日の数) */
  serviceDays: number;
}

export interface MonthlySeikyuResult {
  rows: UserSeikyuRow[];
  /** 集計対象月 (YYYY-MM) */
  month: string;
  /** 対象実績 (completed) 総件数 */
  recordCount: number;
}

// 処遇改善加算等 (= 月次総単位数に % を掛ける加算) は
// offices.applied_formula_codes と kaigo_service_codes.formula
// (monthly_aggregate: 所定単位 × numerator/denominator) を突合して計算する。

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function aggregateMonthlyVisitSeikyu(
  supabase: SupabaseClient,
  opts: {
    officeId: string | null;
    tenantId: string;
    year: number;
    month: number; // 1-12
    /** 自事業所の 地域単価 (offices.unit_price)。未指定 10.0 */
    unitPrice?: number;
    /** 自事業所の applied_formula_codes (処遇改善等) */
    appliedFormulaCodes?: string[];
  },
): Promise<MonthlySeikyuResult> {
  const monthStr = `${opts.year}-${String(opts.month).padStart(2, "0")}`;
  const daysInMonth = new Date(opts.year, opts.month, 0).getDate();
  const from = `${monthStr}-01`;
  const to = `${monthStr}-${String(daysInMonth).padStart(2, "0")}`;

  // 1) 実績 (completed) を月範囲で取得 (page-loop)
  const PAGE = 1000;
  const schedules: { user_id: string; service_type: string; visit_date: string }[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("kaigo_visit_schedule")
      .select("user_id, service_type, visit_date")
      .eq("status", "completed")
      .gte("visit_date", from)
      .lte("visit_date", to)
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`実績取得失敗: ${error.message}`);
    const rows = (data ?? []) as { user_id: string; service_type: string; visit_date: string }[];
    schedules.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  if (schedules.length === 0) {
    return { rows: [], month: monthStr, recordCount: 0 };
  }

  // 2) service_name → units / short_name のマスタ
  // マスタは全角数字 (身体介護３) / schedule は半角混在のため
  // variants で検索し、正規化キー (半角) で引く
  const serviceTypes = Array.from(new Set(schedules.map((s) => s.service_type)));
  const unitByNorm = new Map<string, { units: number; short: string | null; code: string | null }>();
  const variants = serviceNameVariantsAll(serviceTypes);
  // .in() の URL 長対策で 50 件ずつ chunk
  for (let i = 0; i < variants.length; i += 50) {
    const chunk = variants.slice(i, i + 50);
    const { data, error } = await supabase
      .from("kaigo_service_codes")
      .select("service_name, short_name, units, service_code")
      .in("service_name", chunk)
      .eq("calculation_type", "基本");
    if (error) throw new Error(`サービスコード取得失敗: ${error.message}`);
    for (const r of (data ?? []) as { service_name: string; short_name: string | null; units: number; service_code: string | null }[]) {
      const key = toHankakuDigits(r.service_name);
      // 同名複数 code は最初の 1 件を採用 (units はどれも同一想定)
      if (!unitByNorm.has(key)) {
        unitByNorm.set(key, { units: r.units, short: r.short_name, code: r.service_code });
      }
    }
  }
  const unitByName = {
    get: (name: string) => unitByNorm.get(toHankakuDigits(name)),
  };

  // 3) 利用者情報 (clients + 最新 insurance record)
  const userIds = Array.from(new Set(schedules.map((s) => s.user_id)));
  const clientById = new Map<
    string,
    { name: string; furigana: string | null; birth: string | null; gender: string | null }
  >();
  for (let i = 0; i < userIds.length; i += 50) {
    const chunk = userIds.slice(i, i + 50);
    const { data, error } = await supabase
      .from("clients")
      .select("id, name, furigana, birth_date, gender")
      .in("id", chunk);
    if (error) throw new Error(`利用者取得失敗: ${error.message}`);
    for (const c of (data ?? []) as { id: string; name: string; furigana: string | null; birth_date: string | null; gender: string | null }[]) {
      clientById.set(c.id, { name: c.name, furigana: c.furigana, birth: c.birth_date, gender: c.gender });
    }
  }

  const insByClient = new Map<
    string,
    {
      insurer: string | null; insured: string | null; level: string | null; copay: number;
      publicExpense: string | null; certStart: string | null; certEnd: string | null;
      careOfficeId: string | null;
    }
  >();
  for (let i = 0; i < userIds.length; i += 50) {
    const chunk = userIds.slice(i, i + 50);
    const { data, error } = await supabase
      .from("client_insurance_records")
      .select("client_id, insurer_number, insured_number, care_level, copay_rate, public_expense, certification_start_date, certification_end_date, care_office_id, effective_date")
      .in("client_id", chunk)
      .order("effective_date", { ascending: false });
    if (error) throw new Error(`保険情報取得失敗: ${error.message}`);
    for (const r of (data ?? []) as {
      client_id: string;
      insurer_number: string | null;
      insured_number: string | null;
      care_level: string | null;
      copay_rate: number | null;
      public_expense: string | null;
      certification_start_date: string | null;
      certification_end_date: string | null;
      care_office_id: string | null;
    }[]) {
      // 最新 (effective_date DESC) の 1 件のみ採用
      if (!insByClient.has(r.client_id)) {
        // copay_rate は「割」単位 (1=1割, 2=2割, 3=3割) で格納されることが
        // あるため、1 以上は /10 して負担率に正規化する (0.1〜0.3 表記も許容)
        const raw = r.copay_rate;
        const copay =
          raw == null || raw <= 0 ? 0.1
          : raw >= 1 ? Math.min(raw / 10, 1)
          : raw;
        insByClient.set(r.client_id, {
          insurer: r.insurer_number,
          insured: r.insured_number,
          level: r.care_level,
          copay,
          publicExpense: r.public_expense?.trim() ? r.public_expense.trim() : null,
          certStart: r.certification_start_date,
          certEnd: r.certification_end_date,
          careOfficeId: r.care_office_id,
        });
      }
    }
  }

  // 4) 処遇改善加算の rate — 適用加算コードの formula をマスタから取得
  //    (monthly_aggregate: 所定単位 × numerator/denominator)
  let addonNum = 0;
  let addonDen = 1;
  let addonLabel: string | null = null;
  let addonCode: string | null = null;
  if ((opts.appliedFormulaCodes ?? []).length > 0) {
    const { data, error } = await supabase
      .from("kaigo_service_codes")
      .select("service_code, service_name, formula")
      .in("service_code", opts.appliedFormulaCodes as string[])
      .eq("system", "介護")
      .not("formula", "is", null);
    if (error) throw new Error(`加算コード取得失敗: ${error.message}`);
    for (const r of (data ?? []) as {
      service_code: string;
      service_name: string;
      formula: { type?: string; numerator?: number; denominator?: number } | null;
    }[]) {
      const f = r.formula;
      if (f?.type === "monthly_aggregate" && f.numerator && f.denominator) {
        // 処遇改善Ⅰ〜Ⅳ は排他のため最初の 1 件を採用
        addonNum = f.numerator;
        addonDen = f.denominator;
        addonLabel = r.service_name;
        addonCode = r.service_code;
        break;
      }
    }
  }

  // 4.5) 担当居宅介護支援事業所番号 (国保連伝送の基本情報レコード用)
  const careOfficeIds = Array.from(
    new Set(
      Array.from(insByClient.values())
        .map((v) => v.careOfficeId)
        .filter(Boolean) as string[],
    ),
  );
  const officeNumberById = new Map<string, string | null>();
  if (careOfficeIds.length > 0) {
    const { data, error } = await supabase
      .from("offices")
      .select("id, business_number")
      .in("id", careOfficeIds);
    if (error) throw new Error(`居宅事業所取得失敗: ${error.message}`);
    for (const o of (data ?? []) as { id: string; business_number: string | null }[]) {
      officeNumberById.set(o.id, o.business_number);
    }
  }

  const unitPrice = opts.unitPrice && opts.unitPrice > 0 ? opts.unitPrice : 10.0;

  // 5) 利用者ごとに集計
  const byUser = new Map<string, Map<string, number>>(); // user_id → (service_type → count)
  const daysByUser = new Map<string, Set<string>>(); // user_id → 訪問日 set (実日数)
  for (const s of schedules) {
    if (!byUser.has(s.user_id)) byUser.set(s.user_id, new Map());
    const m = byUser.get(s.user_id)!;
    m.set(s.service_type, (m.get(s.service_type) ?? 0) + 1);
    if (!daysByUser.has(s.user_id)) daysByUser.set(s.user_id, new Set());
    daysByUser.get(s.user_id)!.add(s.visit_date);
  }

  const rows: UserSeikyuRow[] = [];
  for (const [userId, typeCounts] of byUser) {
    const client = clientById.get(userId);
    const ins = insByClient.get(userId);
    const details: SeikyuDetailLine[] = [];
    let baseUnits = 0;
    for (const [svcType, count] of typeCounts) {
      const master = unitByName.get(svcType);
      const unitPer = master?.units ?? 0;
      const units = unitPer * count;
      baseUnits += units;
      details.push({
        service_type: svcType,
        short_name: master?.short ?? null,
        service_code: master?.code ?? null,
        unit_per: unitPer,
        count,
        units,
      });
    }
    details.sort((a, b) => b.units - a.units);

    const addonUnits = addonNum > 0 ? Math.round((baseUnits * addonNum) / addonDen) : 0;
    const totalUnits = baseUnits + addonUnits;
    const totalAmount = Math.floor(totalUnits * unitPrice);
    const copay = ins?.copay ?? 0.1;
    // 国保連方式: 保険請求額 = 費用総額 × 給付率 (1円未満切捨)、利用者負担 = 差引
    // (端数は利用者負担側に乗る。先に負担額を切捨てると 1 円ずれる)
    const insuranceAmount = Math.floor(totalAmount * (1 - copay));
    // 公費 (生活保護等): 本人負担分を公費請求へ振替 (本人負担 0 の簡易版)
    const publicExpense = ins?.publicExpense ?? null;
    const kohiUnits = publicExpense ? totalUnits : null;
    const kohiAmount = publicExpense ? totalAmount - insuranceAmount : null;
    const userAmount = publicExpense ? 0 : totalAmount - insuranceAmount;

    rows.push({
      user_id: userId,
      user_name: client?.name ?? "(利用者不明)",
      user_name_kana: client?.furigana ?? null,
      insurer_number: ins?.insurer ?? null,
      insured_number: ins?.insured ?? null,
      care_level: ins?.level ?? null,
      copay_rate: copay,
      details,
      baseUnits,
      addonUnits,
      addonLabel,
      totalUnits,
      unitPrice,
      totalAmount,
      insuranceAmount,
      userAmount,
      publicExpense,
      kohiUnits,
      kohiAmount,
      addonCode,
      birthDate: client?.birth ?? null,
      gender: client?.gender ?? null,
      certStart: ins?.certStart ?? null,
      certEnd: ins?.certEnd ?? null,
      careOfficeNumber: ins?.careOfficeId
        ? officeNumberById.get(ins.careOfficeId) ?? null
        : null,
      serviceDays: daysByUser.get(userId)?.size ?? 0,
    });
  }

  // ふりがな順
  rows.sort((a, b) =>
    (a.user_name_kana ?? a.user_name).localeCompare(
      b.user_name_kana ?? b.user_name,
      "ja",
    ),
  );

  return { rows, month: monthStr, recordCount: schedules.length };
}
