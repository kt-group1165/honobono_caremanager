/**
 * 移動支援・訪問入浴 (地域生活支援給付) の ★ 金額計算 — 純関数
 *
 * ── なぜ切り出すか ────────────────────────────────────────────────────────
 *   これまで `idou-billing/idou-billing-content.tsx` (client component) の
 *   useMemo / useCallback の中に直接書かれていた。★ ハーネスから呼べないので
 *   一度も検証されていない。
 *
 *   同じことが `idou-billing-lines.ts` で既に起きている。あちらのヘッダにこうある:
 *     「client component の中にあってテストから呼べず、★ 加算が1行も出ない不具合に
 *       気づけなかった」
 *   ★ 同じ構造が金額側にも残っていたので、同じ形で切り出す。
 *
 * ⚠ 挙動は変えていない。★ 呼べる場所に移しただけ。
 */

/** 地域生活支援給付の単価。★ 10円固定 (国保連を通らず市へ直接請求するため地域区分が無い) */
export const UNIT_YEN = 10;

/** 受給者証から読む、金額に効く 2 項目だけ */
export type BurdenCert = {
  /** 負担上限月額。★ null = 未設定 (判定不能) / 0 = 非課税で本当に 0 円 */
  limit: number | null;
  /** 生活保護 */
  seiho: boolean;
};

/**
 * ★ 利用者負担が決められるか。
 *
 * ⚠ 判定不能なときに ★ 金額を推測してはいけない。
 *   0 にすると市へ全額請求 / 1割にすると利用者へ過大請求。★ どちらも誤り。
 *   金額は 0 のままにして、画面の警告で必ず気づけるようにする。
 */
export function isBurdenUndeterminable(cert: BurdenCert | undefined): boolean {
  if (!cert) return true; // 受給者証が無い
  if (cert.seiho) return false; // 生保は 0 円で正しい
  return cert.limit == null; // 負担上限額が未設定
}

/**
 * 利用者負担額 = 生保 → 0 / それ以外 → min(総費用 × 10%, 負担上限月額)
 *
 * ⚠ ★ `limit === 0` は「非課税で本当に 0 円」であって未設定ではない。
 *   `?? 0` で潰すと 未設定 と区別が付かなくなる (2026-08-31 の監査で実際に起きた)。
 */
export function clientBurdenOf(cert: BurdenCert | undefined, cost: number): number {
  if (!cert || cert.seiho || cert.limit == null) return 0;
  return Math.min(Math.floor(cost * 0.1), cert.limit);
}

export type IdouSummary = {
  /** 請求対象の利用者数 */
  count: number;
  /** 総単位数 */
  totalUnits: number;
  /** 総費用額 (円) */
  totalCost: number;
  /** 利用者負担額の合計 (円) */
  burden: number;
  /** ★ 市へ請求する額 = 総費用 − 利用者負担 */
  cityClaim: number;
};

/**
 * 事業所の請求書サマリ。
 *
 * ⚠ ★ 負担は 利用者ごとに 上限を当ててから 足す。
 *   事業所の総費用に一括で 10% を掛けると ★ 上限が効かず過大になる。
 */
export function summarizeIdouBilling(
  unitsByClient: ReadonlyMap<string, number>,
  certs: ReadonlyMap<string, BurdenCert>,
): IdouSummary {
  let totalUnits = 0;
  let burden = 0;
  for (const [clientId, units] of unitsByClient) {
    totalUnits += units;
    burden += clientBurdenOf(certs.get(clientId), units * UNIT_YEN);
  }
  const totalCost = totalUnits * UNIT_YEN;
  return { count: unitsByClient.size, totalUnits, totalCost, burden, cityClaim: totalCost - burden };
}
