/**
 * 介護給付費請求明細書 基本情報レコード (7121など)
 *
 * 様式共通の明細書ヘッダー（被保険者情報・事業所情報等）
 * 仕様書「サービス事業所編」2.3.1 (4) 介護給付費請求書別紙情報
 */

import type { FieldDef } from "./field-types";
import { buildRecord } from "./field-types";

export const FIELDS_MEISAI_BASE: FieldDef[] = [
  { name: "交換情報識別番号", type: "AN", length: 4, required: true },
  { name: "サービス提供年月", type: "N", length: 6, required: true },
  { name: "事業所番号", type: "AN", length: 10, required: true },
  { name: "指定/基準該当等事業所区分コード", type: "N", length: 1, required: true },
  { name: "地域区分", type: "N", length: 1, required: true },
  { name: "サービス種類コード", type: "AN", length: 2, required: true },
  { name: "施設等の区分コード", type: "N", length: 1, required: false },
  { name: "人員配置区分コード", type: "N", length: 1, required: false },
  { name: "特別地域加算の有無", type: "N", length: 1, required: false },
  { name: "緊急時訪問看護加算の有無", type: "N", length: 1, required: false },
  { name: "特別管理体制", type: "N", length: 1, required: false },
  { name: "機能訓練体制の有無", type: "N", length: 1, required: false },
  { name: "食事提供体制の有無", type: "N", length: 1, required: false },
  { name: "入浴介助加算の有無", type: "N", length: 1, required: false },
  { name: "特別入浴介助加算の有無", type: "N", length: 1, required: false },
  { name: "リハビリテーション体制の有無", type: "N", length: 1, required: false },
  { name: "基準省令別則", type: "N", length: 1, required: false },
  { name: "常勤専従医師配置の有無", type: "N", length: 1, required: false },
  { name: "看護職員夜勤条件基準", type: "N", length: 1, required: false },
  { name: "平成10年省令", type: "N", length: 1, required: false },
  { name: "医師の配置", type: "N", length: 1, required: false },
  { name: "精神科医師定期診療の有無", type: "N", length: 1, required: false },
  { name: "夜間勤務条件", type: "N", length: 1, required: false },
  { name: "認知症専門棟の有無", type: "N", length: 1, required: false },
  { name: "食事管理の状況", type: "N", length: 1, required: false },
  { name: "特別食の提供の有無", type: "N", length: 1, required: false },
  { name: "送迎体制", type: "N", length: 1, required: false },
  { name: "職員の欠員の状況", type: "N", length: 1, required: false },
  { name: "生活保護法による指定の有無", type: "N", length: 1, required: false },
  { name: "被保険者番号", type: "AN", length: 10, required: true },
  { name: "氏名", type: "ZEN", length: 20, required: true },
  { name: "生年月日", type: "N", length: 7, required: true },  // 元号1+YYMMDD
  { name: "性別", type: "N", length: 1, required: true },
  { name: "要介護状態区分コード", type: "N", length: 2, required: true },
  { name: "旧措置入所者特例", type: "N", length: 1, required: false },
  { name: "認定有効期間_開始", type: "N", length: 7, required: true },
  { name: "認定有効期間_終了", type: "N", length: 7, required: true },
  { name: "居宅サービス計画作成区分コード", type: "N", length: 1, required: false },
  { name: "居宅介護支援事業所番号", type: "AN", length: 10, required: false },
  { name: "開始年月日", type: "N", length: 7, required: false },
  { name: "中止年月日", type: "N", length: 7, required: false },
  { name: "中止理由", type: "N", length: 2, required: false },
  { name: "入所実日数", type: "N", length: 3, required: false },
  { name: "外泊日数", type: "N", length: 3, required: false },
  { name: "合計単位数", type: "N", length: 10, required: true },
  { name: "公費1_負担者番号", type: "N", length: 8, required: false },
  { name: "公費1_受給者番号", type: "N", length: 7, required: false },
  { name: "公費2_負担者番号", type: "N", length: 8, required: false },
  { name: "公費2_受給者番号", type: "N", length: 7, required: false },
  { name: "公費3_負担者番号", type: "N", length: 8, required: false },
  { name: "公費3_受給者番号", type: "N", length: 7, required: false },
  { name: "保険者番号", type: "N", length: 6, required: true },
  { name: "証記載保険者番号", type: "N", length: 6, required: true },
];

export interface MeisaiBaseInput {
  exchangeId: string;           // 識別番号 "7121" など様式ごと
  serviceYearMonth: string;     // "202604"
  providerNumber: string;
  serviceTypeCode: string;      // "43"=居宅介護支援, "11"=訪問介護
  areaCode: number;             // 地域区分
  insuredNumber: string;        // 被保険者番号
  userName: string;
  birthDate: string;            // "YYYYMMDD"
  gender: "1" | "2";            // 1=男, 2=女
  careLevelCode: string;        // "12"=要介護1, "13"=要介護2 等
  certStartDate: string;        // "YYYYMMDD"
  certEndDate: string;
  insurerNumber: string;        // 保険者番号（6桁）
  providerInsurerNumber?: string; // 証記載保険者番号（通常同じ）
  totalUnits: number;
  startDate?: string;           // 開始年月日
}

/**
 * 元号＋6桁年月日に変換（1=明治, 2=大正, 3=昭和, 4=平成, 5=令和）
 */
export function toEraDate(yyyymmdd: string): string {
  if (!yyyymmdd || yyyymmdd.length < 8) return "0000000";
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const mm = yyyymmdd.slice(4, 6);
  const dd = yyyymmdd.slice(6, 8);
  let era = "5";
  let eraYear = y - 2018;
  if (y < 1926) { era = "1"; eraYear = y - 1867; }
  else if (y < 1989) { era = "3"; eraYear = y - 1925; }
  else if (y < 2019) { era = "4"; eraYear = y - 1988; }
  return era + String(eraYear).padStart(2, "0") + mm + dd;
}

export function buildMeisaiBase(input: MeisaiBaseInput, exchangeId: string = "7121"): string {
  return buildRecord(FIELDS_MEISAI_BASE, {
    "交換情報識別番号": exchangeId,
    "サービス提供年月": input.serviceYearMonth,
    "事業所番号": input.providerNumber,
    "指定/基準該当等事業所区分コード": 1, // 1=指定事業所
    "地域区分": input.areaCode,
    "サービス種類コード": input.serviceTypeCode,
    "施設等の区分コード": "",
    "人員配置区分コード": "",
    "特別地域加算の有無": "",
    "緊急時訪問看護加算の有無": "",
    "特別管理体制": "",
    "機能訓練体制の有無": "",
    "食事提供体制の有無": "",
    "入浴介助加算の有無": "",
    "特別入浴介助加算の有無": "",
    "リハビリテーション体制の有無": "",
    "基準省令別則": "",
    "常勤専従医師配置の有無": "",
    "看護職員夜勤条件基準": "",
    "平成10年省令": "",
    "医師の配置": "",
    "精神科医師定期診療の有無": "",
    "夜間勤務条件": "",
    "認知症専門棟の有無": "",
    "食事管理の状況": "",
    "特別食の提供の有無": "",
    "送迎体制": "",
    "職員の欠員の状況": "",
    "生活保護法による指定の有無": "",
    "被保険者番号": input.insuredNumber,
    "氏名": input.userName,
    "生年月日": toEraDate(input.birthDate),
    "性別": input.gender,
    "要介護状態区分コード": input.careLevelCode,
    "旧措置入所者特例": "",
    "認定有効期間_開始": toEraDate(input.certStartDate),
    "認定有効期間_終了": toEraDate(input.certEndDate),
    "居宅サービス計画作成区分コード": 1,
    "居宅介護支援事業所番号": input.providerNumber,
    "開始年月日": input.startDate ? toEraDate(input.startDate) : "",
    "中止年月日": "",
    "中止理由": "",
    "入所実日数": "",
    "外泊日数": "",
    "合計単位数": input.totalUnits,
    "公費1_負担者番号": "",
    "公費1_受給者番号": "",
    "公費2_負担者番号": "",
    "公費2_受給者番号": "",
    "公費3_負担者番号": "",
    "公費3_受給者番号": "",
    "保険者番号": input.insurerNumber,
    "証記載保険者番号": input.providerInsurerNumber ?? input.insurerNumber,
  });
}
