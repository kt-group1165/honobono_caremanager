/**
 * 集計情報レコード
 *
 * サービス種類ごとの単位数・費用合計・保険請求額・利用者負担の集計
 * 仕様書「サービス事業所編」2.3.1 (5) 介護給付費請求明細書情報 集計情報
 */

import type { FieldDef } from "./field-types";
import { buildRecord } from "./field-types";

export const FIELDS_SHUKEI: FieldDef[] = [
  { name: "交換情報識別番号", type: "AN", length: 4, required: true },
  { name: "レコード種別コード", type: "N", length: 2, required: true, fixed: "08" },
  { name: "サービス提供年月", type: "N", length: 6, required: true },
  { name: "事業所番号", type: "AN", length: 10, required: true },
  { name: "証記載保険者番号", type: "N", length: 6, required: true },
  { name: "被保険者番号", type: "AN", length: 10, required: true },
  { name: "サービス種類コード", type: "AN", length: 2, required: true },
  { name: "サービス実日数", type: "N", length: 2, required: false },
  { name: "計画単位数", type: "N", length: 6, required: true },
  { name: "限度額管理対象単位数", type: "N", length: 6, required: true },
  { name: "限度額管理対象外単位数", type: "N", length: 6, required: true },
  { name: "給付単位数", type: "N", length: 6, required: true },
  { name: "公費分_単位数", type: "N", length: 6, required: false },
  { name: "単位数単価", type: "N", length: 6, required: true },        // 小数点2桁・6桁（例 1040 → 10.40）
  { name: "費用合計", type: "N", length: 8, required: true },
  { name: "保険分_請求額", type: "N", length: 8, required: true },
  { name: "利用者負担額", type: "N", length: 8, required: true },
  { name: "公費対象額", type: "N", length: 8, required: false },
  { name: "公費分_請求額", type: "N", length: 8, required: false },
  { name: "公費分_本人負担額", type: "N", length: 8, required: false },
  { name: "社会福祉法人等軽減額", type: "N", length: 8, required: false },
];

export interface ShukeiInput {
  exchangeId: string;
  serviceYearMonth: string;
  providerNumber: string;
  insurerNumber: string;
  insuredNumber: string;
  serviceTypeCode: string;
  actualDays?: number;
  plannedUnits: number;
  limitManagementUnits: number;       // 限度額管理対象単位数
  nonLimitUnits?: number;             // 限度額管理対象外単位数
  benefitUnits: number;               // 給付単位数
  unitPrice: number;                  // 単位数単価（例: 10.40）
  totalCost: number;
  insuranceClaim: number;
  userCopay: number;
}

export function buildShukei(input: ShukeiInput): string {
  // 単位数単価を小数点2桁固定で 1040 → "001040" の形に
  const unitPriceInt = Math.round(input.unitPrice * 100);

  return buildRecord(FIELDS_SHUKEI, {
    "交換情報識別番号": input.exchangeId,
    "サービス提供年月": input.serviceYearMonth,
    "事業所番号": input.providerNumber,
    "証記載保険者番号": input.insurerNumber,
    "被保険者番号": input.insuredNumber,
    "サービス種類コード": input.serviceTypeCode,
    "サービス実日数": input.actualDays ?? 0,
    "計画単位数": input.plannedUnits,
    "限度額管理対象単位数": input.limitManagementUnits,
    "限度額管理対象外単位数": input.nonLimitUnits ?? 0,
    "給付単位数": input.benefitUnits,
    "公費分_単位数": 0,
    "単位数単価": unitPriceInt,
    "費用合計": input.totalCost,
    "保険分_請求額": input.insuranceClaim,
    "利用者負担額": input.userCopay,
    "公費対象額": 0,
    "公費分_請求額": 0,
    "公費分_本人負担額": 0,
    "社会福祉法人等軽減額": 0,
  });
}
