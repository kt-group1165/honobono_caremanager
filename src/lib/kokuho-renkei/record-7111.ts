/**
 * 7111 介護給付費請求書情報（請求書集計ヘッダー）
 *
 * 仕様書「サービス事業所編 令和6年4月」2.3.1 (1) 介護給付費請求書情報
 * - 事業所番号単位の請求書情報
 * - 件数・単位数・費用合計・保険請求額・公費負担・利用者負担の集計値
 */

import type { FieldDef } from "./field-types";
import { buildRecord } from "./field-types";

export const FIELDS_7111: FieldDef[] = [
  { name: "交換情報識別番号", type: "AN", length: 4, fixed: "7111", required: true },
  { name: "サービス提供年月", type: "N", length: 6, required: true }, // YYYYMM
  { name: "事業所番号", type: "AN", length: 10, required: true },
  { name: "保険・公費等区分番号", type: "N", length: 1, required: true },
  { name: "法別番号", type: "N", length: 2, required: false },
  { name: "請求情報区分コード", type: "N", length: 2, required: true },
  { name: "件数", type: "N", length: 8, required: true },
  { name: "単位数", type: "N", length: 11, required: true },
  { name: "費用合計", type: "N", length: 11, required: true },
  { name: "保険請求額", type: "N", length: 11, required: true },
  { name: "公費請求額", type: "N", length: 11, required: true },
  { name: "利用者負担", type: "N", length: 11, required: true },
  { name: "件数_延べ日数", type: "N", length: 6, required: false },
  { name: "特定入所者介護サービス費等_件数", type: "N", length: 3, required: false },
  { name: "特定入所者介護サービス費等_費用合計", type: "N", length: 11, required: false },
  { name: "特定入所者介護サービス費等_利用者負担", type: "N", length: 11, required: false },
  { name: "特定入所者介護サービス費等_公費請求額", type: "N", length: 11, required: false },
  { name: "特定入所者介護サービス費等_保険請求額", type: "N", length: 11, required: false },
];

/**
 * 7111 レコードを生成
 */
export interface Record7111Input {
  serviceYearMonth: string;      // "202604" (YYYYMM)
  providerNumber: string;         // 事業所番号 10桁
  insuranceDivision: number;      // 保険・公費等区分番号 (1=介護保険)
  lawNumber?: string;             // 法別番号（通常空）
  requestDivisionCode: string;    // 請求情報区分コード ("11"=介護給付費 など)
  count: number;                  // 件数
  units: number;                  // 単位数
  totalCost: number;              // 費用合計
  insuranceClaim: number;         // 保険請求額
  publicClaim: number;            // 公費請求額
  userCopay: number;              // 利用者負担
}

export function buildRecord7111(input: Record7111Input): string {
  return buildRecord(FIELDS_7111, {
    "サービス提供年月": input.serviceYearMonth,
    "事業所番号": input.providerNumber,
    "保険・公費等区分番号": input.insuranceDivision,
    "法別番号": input.lawNumber ?? "",
    "請求情報区分コード": input.requestDivisionCode,
    "件数": input.count,
    "単位数": input.units,
    "費用合計": input.totalCost,
    "保険請求額": input.insuranceClaim,
    "公費請求額": input.publicClaim,
    "利用者負担": input.userCopay,
    "件数_延べ日数": 0,
    "特定入所者介護サービス費等_件数": 0,
    "特定入所者介護サービス費等_費用合計": 0,
    "特定入所者介護サービス費等_利用者負担": 0,
    "特定入所者介護サービス費等_公費請求額": 0,
    "特定入所者介護サービス費等_保険請求額": 0,
  });
}
