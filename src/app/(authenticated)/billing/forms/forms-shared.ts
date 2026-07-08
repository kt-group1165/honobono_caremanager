// Server Component (page.tsx) と Client Component (billing-forms-content.tsx) の
// 両方から import する共有 module ("use client" を付けない)。
// memory: feedback_use_client_const_export.md と同じ pattern (claims-shared.ts 参照)。

/**
 * 利用者ごとの公費 (生活保護等) 情報 — client_insurance_records の最新行から取得。
 *
 * パターン1 (公費併用): 介護保険の被保険者 + 法別12 (生活保護)。
 *   居宅介護支援費は 10 割給付で本人負担が元々 0 円のため公費振替額は 0 円だが、
 *   レセプト (様式第一/第七) には公費情報 (負担者番号・受給者番号) を記載する。
 * パターン2 (公費単独): 被保険者番号が 'H' 始まり = 介護保険未加入の生保受給者
 *   (みなし2号)。保険請求に載せず、総費用の 10 割を公費単独で請求する。
 */
export interface KohiInfo {
  insuredNumber: string | null;
  /** 公費 法別番号 (12=生活保護 等) */
  kohiHobetsu: string | null;
  /** 公費負担者番号 (8桁) */
  kohiFutansha: string | null;
  /** 公費受給者番号 (7桁) */
  kohiJukyusha: string | null;
  /** 公費単独 (10割公費)。被保険者番号 'H' 始まり */
  kohiTandoku: boolean;
  /** 公費情報あり (単独 or 併用) */
  hasKohi: boolean;
}

/** 被保険者番号 'H' 始まり = 公費単独 (みなし2号) 判定 */
export function isKohiTandokuInsured(insured: string | null | undefined): boolean {
  return /^[Hh]/.test((insured ?? "").trim());
}

/** client_insurance_records の 1 行 (最新) から KohiInfo を組み立てる */
export function toKohiInfo(rec: {
  insured_number: string | null;
  kohi_hobetsu: string | null;
  kohi_futansha_number: string | null;
  kohi_jukyusha_number: string | null;
}): KohiInfo {
  const tandoku = isKohiTandokuInsured(rec.insured_number);
  const hobetsu = rec.kohi_hobetsu?.trim() || null;
  return {
    insuredNumber: rec.insured_number,
    kohiHobetsu: hobetsu,
    kohiFutansha: rec.kohi_futansha_number?.trim() || null,
    kohiJukyusha: rec.kohi_jukyusha_number?.trim() || null,
    kohiTandoku: tandoku,
    hasKohi: tandoku || !!hobetsu,
  };
}
