/**
 * 障害福祉サービス コード検索・提供可否判定
 *
 * 監査 2026-07-09: 旧 aggregateMonthly / unitToYen / computeRecordUnits /
 * AREA_UNIT_PRICES は未使用の死コード (かつ行ごと floor の誤丸めで、将来
 * 誤配線されると 1円ズレを生む) のため削除。障害の請求集計の本線は
 * lib/shogai-seikyu/aggregate.ts (aggregateMonthlyShogaiSeikyu)。
 */

import type { ShogaiServiceCode, ShogaiServiceType } from "./types";

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
