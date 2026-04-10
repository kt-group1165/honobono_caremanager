/**
 * 国保連伝送用ファイル生成 - 統合ビルダー
 *
 * 複数のレセプトデータを受け取り、国保連仕様の固定長テキスト(Shift-JIS)
 * ファイルを生成して Blob を返す。
 */

import { buildSjisBlob, downloadBlob } from "./encoding";
import { buildRecord7111, type Record7111Input } from "./record-7111";
import { buildMeisaiBase, type MeisaiBaseInput } from "./record-meisai-base";
import { buildMeisaiY7, type MeisaiY7Input } from "./record-meisai-y7";
import { buildMeisaiY2, type MeisaiY2Input } from "./record-meisai-y2";
import { buildShukei, type ShukeiInput } from "./record-shukei";

export * from "./encoding";
export * from "./field-types";
export * from "./record-7111";
export * from "./record-meisai-base";
export * from "./record-meisai-y7";
export * from "./record-meisai-y2";
export * from "./record-shukei";

// ─── ケアマネ版レセプト入力 ──────────────────────────────────────────────────

/**
 * 居宅介護支援（ケアマネ）レセプトの1利用者分
 */
export interface CareMgmtClaim {
  base: MeisaiBaseInput;                  // 基本情報（利用者・認定情報）
  mainService: Omit<MeisaiY7Input, "exchangeId" | "serviceYearMonth" | "providerNumber" | "insurerNumber" | "insuredNumber" | "serviceTypeCode">;
  additions: Array<Omit<MeisaiY7Input, "exchangeId" | "serviceYearMonth" | "providerNumber" | "insurerNumber" | "insuredNumber" | "serviceTypeCode">>;
  shukei: Omit<ShukeiInput, "exchangeId" | "serviceYearMonth" | "providerNumber" | "insurerNumber" | "insuredNumber" | "serviceTypeCode">;
}

/**
 * ケアマネ版レセプト一括出力
 */
export interface CareMgmtFileInput {
  serviceYearMonth: string;          // "202604"
  providerNumber: string;            // 事業所番号
  areaCode: number;                  // 地域区分
  unitPrice: number;                 // 単位数単価
  claims: CareMgmtClaim[];           // 複数利用者分
}

export function buildCareMgmtFile(input: CareMgmtFileInput): Blob {
  const records: string[] = [];
  const exchangeId = "7121";          // 居宅介護支援（様式第七）
  const serviceTypeCode = "43";       // サービス種類コード

  // 集計値計算
  let totalCount = 0;
  let totalUnits = 0;
  let totalCost = 0;
  let totalInsuranceClaim = 0;
  let totalUserCopay = 0;

  // 1. 請求書情報 (7111) ヘッダー - 事業所全体の集計
  // 仕様では「件数」は利用者数（明細書数）
  for (const claim of input.claims) {
    totalCount++;
    totalUnits += claim.base.totalUnits;
    totalCost += claim.shukei.totalCost;
    totalInsuranceClaim += claim.shukei.insuranceClaim;
    totalUserCopay += claim.shukei.userCopay;
  }

  const record7111: Record7111Input = {
    serviceYearMonth: input.serviceYearMonth,
    providerNumber: input.providerNumber,
    insuranceDivision: 1,
    lawNumber: "",
    requestDivisionCode: "11",        // 介護給付費請求
    count: totalCount,
    units: totalUnits,
    totalCost: totalCost,
    insuranceClaim: totalInsuranceClaim,
    publicClaim: 0,
    userCopay: totalUserCopay,
  };
  records.push(buildRecord7111(record7111));

  // 2. 各利用者の明細書レコード群
  for (const claim of input.claims) {
    // 基本情報
    records.push(buildMeisaiBase(claim.base, exchangeId));

    // 明細情報（メインサービス）
    records.push(
      buildMeisaiY7({
        exchangeId,
        serviceYearMonth: input.serviceYearMonth,
        providerNumber: input.providerNumber,
        insurerNumber: claim.base.insurerNumber,
        insuredNumber: claim.base.insuredNumber,
        serviceTypeCode,
        ...claim.mainService,
      })
    );

    // 加算レコード（初回加算、特定事業所加算等）
    for (const add of claim.additions) {
      records.push(
        buildMeisaiY7({
          exchangeId,
          serviceYearMonth: input.serviceYearMonth,
          providerNumber: input.providerNumber,
          insurerNumber: claim.base.insurerNumber,
          insuredNumber: claim.base.insuredNumber,
          serviceTypeCode,
          ...add,
        })
      );
    }

    // 集計情報
    records.push(
      buildShukei({
        exchangeId,
        serviceYearMonth: input.serviceYearMonth,
        providerNumber: input.providerNumber,
        insurerNumber: claim.base.insurerNumber,
        insuredNumber: claim.base.insuredNumber,
        serviceTypeCode,
        ...claim.shukei,
      })
    );
  }

  return buildSjisBlob(records);
}

// ─── 訪問介護版 ─────────────────────────────────────────────────────────────

export interface HomeCareClaim {
  base: MeisaiBaseInput;
  services: Array<Omit<MeisaiY2Input, "exchangeId" | "serviceYearMonth" | "providerNumber" | "insurerNumber" | "insuredNumber" | "serviceTypeCode">>;
  shukei: Omit<ShukeiInput, "exchangeId" | "serviceYearMonth" | "providerNumber" | "insurerNumber" | "insuredNumber" | "serviceTypeCode">;
}

export interface HomeCareFileInput {
  serviceYearMonth: string;
  providerNumber: string;
  serviceTypeCode: string;        // "11"=訪問介護、"13"=訪問看護 等
  areaCode: number;
  unitPrice: number;
  claims: HomeCareClaim[];
}

export function buildHomeCareFile(input: HomeCareFileInput): Blob {
  const records: string[] = [];
  const exchangeId = "7131";        // 訪問系介護サービス等

  let totalCount = 0;
  let totalUnits = 0;
  let totalCost = 0;
  let totalInsuranceClaim = 0;
  let totalUserCopay = 0;

  for (const claim of input.claims) {
    totalCount++;
    totalUnits += claim.base.totalUnits;
    totalCost += claim.shukei.totalCost;
    totalInsuranceClaim += claim.shukei.insuranceClaim;
    totalUserCopay += claim.shukei.userCopay;
  }

  // 1. 請求書情報
  records.push(
    buildRecord7111({
      serviceYearMonth: input.serviceYearMonth,
      providerNumber: input.providerNumber,
      insuranceDivision: 1,
      requestDivisionCode: "11",
      count: totalCount,
      units: totalUnits,
      totalCost,
      insuranceClaim: totalInsuranceClaim,
      publicClaim: 0,
      userCopay: totalUserCopay,
    })
  );

  // 2. 各利用者の明細書レコード群
  for (const claim of input.claims) {
    records.push(buildMeisaiBase(claim.base, exchangeId));

    for (const svc of claim.services) {
      records.push(
        buildMeisaiY2({
          exchangeId,
          serviceYearMonth: input.serviceYearMonth,
          providerNumber: input.providerNumber,
          insurerNumber: claim.base.insurerNumber,
          insuredNumber: claim.base.insuredNumber,
          serviceTypeCode: input.serviceTypeCode,
          ...svc,
        })
      );
    }

    records.push(
      buildShukei({
        exchangeId,
        serviceYearMonth: input.serviceYearMonth,
        providerNumber: input.providerNumber,
        insurerNumber: claim.base.insurerNumber,
        insuredNumber: claim.base.insuredNumber,
        serviceTypeCode: input.serviceTypeCode,
        ...claim.shukei,
      })
    );
  }

  return buildSjisBlob(records);
}

// ─── ダウンロードヘルパー ─────────────────────────────────────────────────

/**
 * ケアマネ版レセプトの固定長ファイルを生成してダウンロード
 */
export function downloadCareMgmtFile(input: CareMgmtFileInput): void {
  const blob = buildCareMgmtFile(input);
  const filename = `KYOTAKU_${input.providerNumber}_${input.serviceYearMonth}.csv`;
  downloadBlob(blob, filename);
}

/**
 * 訪問介護版レセプトの固定長ファイルを生成してダウンロード
 */
export function downloadHomeCareFile(input: HomeCareFileInput): void {
  const blob = buildHomeCareFile(input);
  const filename = `HOMONKAIGO_${input.providerNumber}_${input.serviceYearMonth}.csv`;
  downloadBlob(blob, filename);
}
