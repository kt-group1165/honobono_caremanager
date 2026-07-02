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

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SeikyuDetailLine {
  /** サービス名 (身体介護3 等) */
  service_type: string;
  /** 略称 (身3 等)。無ければ service_type */
  short_name: string | null;
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
}

export interface MonthlySeikyuResult {
  rows: UserSeikyuRow[];
  /** 集計対象月 (YYYY-MM) */
  month: string;
  /** 対象実績 (completed) 総件数 */
  recordCount: number;
}

// 処遇改善加算等 (= 月次総単位数に % を掛ける加算) の代表レート
// offices.applied_formula_codes と kaigo_service_codes.formula の突合が理想だが、
// Phase 2 では 訪問介護 処遇改善加算Ⅰ (24.5%) 等の一般値を code から推定する。
const ADDON_LABELS: Record<string, { label: string; pct: number }> = {
  "116275": { label: "処遇改善加算Ⅰ", pct: 24.5 },
  "116271": { label: "処遇改善加算Ⅱ", pct: 22.4 },
  "116269": { label: "処遇改善加算Ⅲ", pct: 18.2 },
  "116267": { label: "処遇改善加算Ⅳ", pct: 14.5 },
};

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
  const schedules: { user_id: string; service_type: string }[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("kaigo_visit_schedule")
      .select("user_id, service_type")
      .eq("status", "completed")
      .gte("visit_date", from)
      .lte("visit_date", to)
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`実績取得失敗: ${error.message}`);
    const rows = (data ?? []) as { user_id: string; service_type: string }[];
    schedules.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  if (schedules.length === 0) {
    return { rows: [], month: monthStr, recordCount: 0 };
  }

  // 2) service_name → units / short_name のマスタ
  const serviceTypes = Array.from(new Set(schedules.map((s) => s.service_type)));
  const unitByName = new Map<string, { units: number; short: string | null }>();
  // .in() の URL 長対策で 50 件ずつ chunk
  for (let i = 0; i < serviceTypes.length; i += 50) {
    const chunk = serviceTypes.slice(i, i + 50);
    const { data, error } = await supabase
      .from("kaigo_service_codes")
      .select("service_name, short_name, units")
      .in("service_name", chunk)
      .eq("calculation_type", "基本");
    if (error) throw new Error(`サービスコード取得失敗: ${error.message}`);
    for (const r of (data ?? []) as { service_name: string; short_name: string | null; units: number }[]) {
      // 同名複数 code は最初の 1 件を採用 (units はどれも同一想定)
      if (!unitByName.has(r.service_name)) {
        unitByName.set(r.service_name, { units: r.units, short: r.short_name });
      }
    }
  }

  // 3) 利用者情報 (clients + 最新 insurance record)
  const userIds = Array.from(new Set(schedules.map((s) => s.user_id)));
  const clientById = new Map<
    string,
    { name: string; furigana: string | null }
  >();
  for (let i = 0; i < userIds.length; i += 50) {
    const chunk = userIds.slice(i, i + 50);
    const { data, error } = await supabase
      .from("clients")
      .select("id, name, furigana")
      .in("id", chunk);
    if (error) throw new Error(`利用者取得失敗: ${error.message}`);
    for (const c of (data ?? []) as { id: string; name: string; furigana: string | null }[]) {
      clientById.set(c.id, { name: c.name, furigana: c.furigana });
    }
  }

  const insByClient = new Map<
    string,
    { insurer: string | null; insured: string | null; level: string | null; copay: number }
  >();
  for (let i = 0; i < userIds.length; i += 50) {
    const chunk = userIds.slice(i, i + 50);
    const { data, error } = await supabase
      .from("client_insurance_records")
      .select("client_id, insurer_number, insured_number, care_level, copay_rate, effective_date")
      .in("client_id", chunk)
      .order("effective_date", { ascending: false });
    if (error) throw new Error(`保険情報取得失敗: ${error.message}`);
    for (const r of (data ?? []) as {
      client_id: string;
      insurer_number: string | null;
      insured_number: string | null;
      care_level: string | null;
      copay_rate: number | null;
    }[]) {
      // 最新 (effective_date DESC) の 1 件のみ採用
      if (!insByClient.has(r.client_id)) {
        insByClient.set(r.client_id, {
          insurer: r.insurer_number,
          insured: r.insured_number,
          level: r.care_level,
          copay: r.copay_rate != null && r.copay_rate > 0 ? r.copay_rate : 0.1,
        });
      }
    }
  }

  // 4) 処遇改善加算の rate (applied_formula_codes から)
  let addonPct = 0;
  let addonLabel: string | null = null;
  for (const code of opts.appliedFormulaCodes ?? []) {
    const meta = ADDON_LABELS[code];
    if (meta) {
      addonPct = meta.pct;
      addonLabel = meta.label;
      break;
    }
  }

  const unitPrice = opts.unitPrice && opts.unitPrice > 0 ? opts.unitPrice : 10.0;

  // 5) 利用者ごとに集計
  const byUser = new Map<string, Map<string, number>>(); // user_id → (service_type → count)
  for (const s of schedules) {
    if (!byUser.has(s.user_id)) byUser.set(s.user_id, new Map());
    const m = byUser.get(s.user_id)!;
    m.set(s.service_type, (m.get(s.service_type) ?? 0) + 1);
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
        unit_per: unitPer,
        count,
        units,
      });
    }
    details.sort((a, b) => b.units - a.units);

    const addonUnits = addonPct > 0 ? Math.round((baseUnits * addonPct) / 100) : 0;
    const totalUnits = baseUnits + addonUnits;
    const totalAmount = Math.floor(totalUnits * unitPrice);
    const copay = ins?.copay ?? 0.1;
    const userAmount = Math.floor(totalAmount * copay);
    const insuranceAmount = totalAmount - userAmount;

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
