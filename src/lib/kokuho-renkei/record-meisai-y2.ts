/**
 * 様式第二 居宅サービス介護給付費明細書 明細情報レコード
 *
 * 訪問介護・訪問看護・訪問リハ・通所介護・通所リハ・
 * 福祉用具貸与・定期巡回・夜間対応型訪問介護等
 *
 * 仕様書「サービス事業所編」2.3.1 (5) 介護給付費請求明細書情報 様式第二
 */

import type { FieldDef } from "./field-types";
import { buildRecord } from "./field-types";

// 様式第二の明細情報レコード（様式第七とほぼ同じ構造）
export const FIELDS_MEISAI_Y2: FieldDef[] = [
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
  { name: "公費分_回数", type: "N", length: 4, required: false },
  { name: "公費分_サービス単位数", type: "N", length: 6, required: false },
  { name: "摘要", type: "ZEN", length: 20, required: false },
];

export interface MeisaiY2Input {
  exchangeId: string;           // "7131" 訪問系の識別番号
  serviceYearMonth: string;
  providerNumber: string;
  insurerNumber: string;
  insuredNumber: string;
  serviceTypeCode: string;      // "11" (訪問介護), "13" (訪問看護) 等
  serviceItemCode: string;      // サービスコード下4桁
  units: number;
  count: number;
  serviceUnits: number;
  publicCount?: number;
  publicUnits?: number;
  note?: string;
}

export function buildMeisaiY2(input: MeisaiY2Input): string {
  return buildRecord(FIELDS_MEISAI_Y2, {
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
    "公費分_回数": input.publicCount ?? 0,
    "公費分_サービス単位数": input.publicUnits ?? 0,
    "摘要": input.note ?? "",
  });
}
