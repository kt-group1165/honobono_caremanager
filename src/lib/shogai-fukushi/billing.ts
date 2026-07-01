/**
 * 障害福祉サービス 単位数 → 金額 計算
 *
 * 令和6年 (2024年) 報酬改定に準拠。
 * 地域区分単価は介護保険と同一 (1級地 11.40 円 〜 その他 10.00 円)。
 */

import type { ShogaiServiceCode, ShogaiServiceType, RecordAddon } from "./types";

// ─────────────────────────────────────────────────────
// 地域区分単価
// ─────────────────────────────────────────────────────
export const AREA_UNIT_PRICES: Record<string, number> = {
  "1級地": 11.4,
  "2級地": 11.12,
  "3級地": 11.05,
  "4級地": 10.84,
  "5級地": 10.7,
  "6級地": 10.42,
  "7級地": 10.21,
  その他: 10.0,
};

export function unitToYen(unit: number, areaCategory: string): number {
  const rate = AREA_UNIT_PRICES[areaCategory] ?? 10.0;
  return Math.floor(unit * rate);
}

// ─────────────────────────────────────────────────────
// 時間帯 → 単位数 検索
// ─────────────────────────────────────────────────────
export interface FindCodeInput {
  serviceType: ShogaiServiceType;
  serviceCategory?: string | null; // 身体介護, 家事援助 等
  durationMinutes: number;
}

export function findServiceCode(
  codes: ShogaiServiceCode[],
  input: FindCodeInput,
): ShogaiServiceCode | null {
  const candidates = codes.filter(
    (c) =>
      c.service_type === input.serviceType &&
      c.is_active &&
      !c.is_addon &&
      (input.serviceCategory
        ? c.service_category === input.serviceCategory
        : true),
  );
  // 時間帯マッチ: min <= duration && (max == null || duration < max)
  for (const c of candidates) {
    const min = c.min_minutes ?? 0;
    const max = c.max_minutes ?? Number.MAX_SAFE_INTEGER;
    if (input.durationMinutes >= min && input.durationMinutes < max) return c;
  }
  return null;
}

// ─────────────────────────────────────────────────────
// 1 record の給付単位数計算 (本体 + 加算)
// ─────────────────────────────────────────────────────
export function computeRecordUnits(input: {
  baseUnit: number;
  addons: RecordAddon[];
}): number {
  const addSum = input.addons.reduce((s, a) => s + (a.units ?? 0), 0);
  return input.baseUnit + addSum;
}

// ─────────────────────────────────────────────────────
// 月次: record 群 → サマリ
// ─────────────────────────────────────────────────────
export interface MonthlyAggregateInput {
  records: Array<{
    service_type: ShogaiServiceType;
    unit_count: number | null;
    addons: RecordAddon[];
    status: "draft" | "confirmed" | "cancelled";
  }>;
  areaCategory: string;
  /** 自己負担割合 (例 10.00 → 10%)、生保等は 0 */
  selfPaymentPercent: number;
  /** 自己負担上限額 (円/月)。0 は「上限なし」相当 */
  selfPaymentLimit: number;
}

export interface MonthlyAggregateResult {
  byType: Partial<
    Record<
      ShogaiServiceType,
      {
        totalUnits: number;
        totalAmount: number;
        userPayment: number;
        benefitPayment: number;
        recordCount: number;
      }
    >
  >;
  total: {
    totalUnits: number;
    totalAmount: number;
    userPayment: number;
    benefitPayment: number;
    recordCount: number;
  };
}

export function aggregateMonthly(
  input: MonthlyAggregateInput,
): MonthlyAggregateResult {
  const byType: MonthlyAggregateResult["byType"] = {};
  let totalUnits = 0;
  let totalAmount = 0;
  let recordCount = 0;

  for (const rec of input.records) {
    if (rec.status === "cancelled") continue;
    const units =
      (rec.unit_count ?? 0) +
      rec.addons.reduce((s, a) => s + (a.units ?? 0), 0);
    const amount = unitToYen(units, input.areaCategory);
    totalUnits += units;
    totalAmount += amount;
    recordCount += 1;
    const cur = byType[rec.service_type] ?? {
      totalUnits: 0,
      totalAmount: 0,
      userPayment: 0,
      benefitPayment: 0,
      recordCount: 0,
    };
    cur.totalUnits += units;
    cur.totalAmount += amount;
    cur.recordCount += 1;
    byType[rec.service_type] = cur;
  }

  // 自己負担 (上限適用前)
  const userBeforeCap = Math.floor(
    (totalAmount * input.selfPaymentPercent) / 100,
  );
  const userPayment =
    input.selfPaymentLimit > 0
      ? Math.min(userBeforeCap, input.selfPaymentLimit)
      : userBeforeCap;
  const benefitPayment = totalAmount - userPayment;

  // byType には比例配分
  for (const t of Object.keys(byType) as ShogaiServiceType[]) {
    const v = byType[t]!;
    v.userPayment = totalAmount > 0
      ? Math.floor((v.totalAmount * userPayment) / totalAmount)
      : 0;
    v.benefitPayment = v.totalAmount - v.userPayment;
  }

  return {
    byType,
    total: {
      totalUnits,
      totalAmount,
      userPayment,
      benefitPayment,
      recordCount,
    },
  };
}

// ─────────────────────────────────────────────────────
// 障害支援区分 x サービス提供可否
// ─────────────────────────────────────────────────────
export function canProvideService(
  serviceType: ShogaiServiceType,
  disabilityClass: number | null,
): boolean {
  if (disabilityClass == null) return true; // 未設定なら判定不能
  switch (serviceType) {
    case "居宅介護":
      return disabilityClass >= 1;
    case "重度訪問介護":
      return disabilityClass >= 4;
    case "行動援護":
      return disabilityClass >= 3;
    case "同行援護":
      return true; // 同行援護は「同行援護アセスメント調査票」で判定 (支援区分不問)
  }
  return true;
}
