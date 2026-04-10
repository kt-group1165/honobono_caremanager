/**
 * 様式第七 居宅介護支援介護給付費明細書 明細情報レコード
 *
 * 仕様書「サービス事業所編」2.3.1 (5) 介護給付費請求明細書情報
 * - 居宅介護支援費（ケアマネ）のサービスコード単位の明細
 * - 基本単位数 + 加算（特定事業所加算、初回加算、入退院時連携加算など）
 */

import type { FieldDef } from "./field-types";
import { buildRecord } from "./field-types";

export const FIELDS_MEISAI_Y7: FieldDef[] = [
  { name: "交換情報識別番号", type: "AN", length: 4, required: true },
  { name: "レコード種別コード", type: "N", length: 2, required: true, fixed: "02" },
  { name: "サービス提供年月", type: "N", length: 6, required: true },
  { name: "事業所番号", type: "AN", length: 10, required: true },
  { name: "証記載保険者番号", type: "N", length: 6, required: true },
  { name: "被保険者番号", type: "AN", length: 10, required: true },
  { name: "サービス種類コード", type: "AN", length: 2, required: true },
  { name: "サービス項目コード", type: "AN", length: 4, required: true },
  { name: "単位数", type: "N", length: 4, required: true },
  { name: "回数", type: "N", length: 4, required: true },
  { name: "サービス単位数", type: "N", length: 6, required: true },
  { name: "摘要", type: "ZEN", length: 20, required: false },
];

export interface MeisaiY7Input {
  exchangeId: string;           // "7121" 等
  serviceYearMonth: string;
  providerNumber: string;
  insurerNumber: string;        // 証記載保険者番号
  insuredNumber: string;
  serviceTypeCode: string;      // "43" (居宅介護支援)
  serviceItemCode: string;      // "2301" = 居宅介護支援費Ⅰⅰ１ 等
  units: number;                // 単位数
  count: number;                // 回数
  serviceUnits: number;         // サービス単位数（units × count）
  note?: string;                // 摘要
}

export function buildMeisaiY7(input: MeisaiY7Input): string {
  return buildRecord(FIELDS_MEISAI_Y7, {
    "交換情報識別番号": input.exchangeId,
    "サービス提供年月": input.serviceYearMonth,
    "事業所番号": input.providerNumber,
    "証記載保険者番号": input.insurerNumber,
    "被保険者番号": input.insuredNumber,
    "サービス種類コード": input.serviceTypeCode,
    "サービス項目コード": input.serviceItemCode,
    "単位数": input.units,
    "回数": input.count,
    "サービス単位数": input.serviceUnits,
    "摘要": input.note ?? "",
  });
}
