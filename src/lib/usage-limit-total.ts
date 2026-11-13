/**
 * 利用票 (第6表) 画面の「区分支給限度」の判定に使う 月の単位数 (2026-11-13 H 承認・案 A)
 *
 * 第7表 (利用票別表 service-usage-detail) がある月は ★ 第7表の 限度額対象の単位の合計 で判定する。無い月は従来どおり
 * 利用票の行から積んだ値 (画面の usedUnits) を使う。
 *
 * なぜ: 利用票の行は 1 行ごとの単位数が無い・回数が違う行が残っていて (いすみ 258 名で 82 名・−131,723 単位の差。
 *   貸与のまとめ行 ほか)、行から積むと月計が過少になり 限度額超過を見落としうる。第7表には ほのぼのが計算した
 *   サービスごとの単位が全部入っている。請求に効く限度額超過の割り振り (第7表画面の GendoAllocationPanel) は
 *   もともと第7表の items から計算しているので、画面の判定もそちらに揃える。
 * ★ 利用票の行は表示用にそのまま残す (まとめ行を割り振らない)。行ごとの単位・合計の行・印刷は変えない。
 *
 * 限度額の対象外 (区分支給限度基準額の管理に入れない) は 第7表の行のサービス名で除く。
 *   KY 8222 (給付管理票の給付計画単位数) と一致することを 2026-11-13 にいすみで確かめた除外:
 *   処遇改善 / 緊急時訪問看護 / サービス提供体制 / 特別管理 / ターミナル / 特別地域 / 中山間 / 同一建物減算 / 居宅療養管理指導
 *   (同一建物減算は「第7表から除いた値 = KY」を 4/4 で確認。居宅療養管理指導はそもそも区分支給限度の外)
 */

/** 区分支給限度基準額の管理に入れないサービス (第7表の service_content で判定) */
export const LIMIT_EXEMPT_PATTERN = /処遇改善|緊急時訪問看護|提供体制|特別管理|ターミナル|特別地域|中山間|同一建物減算|居宅療養/;

export type DetailItemLike = {
  service_content?: string | null;
  service_units?: number | string | null;
};

export type UsageLimitSource = "service-usage-detail" | "services";

/** 第7表の行から 限度額対象の単位の合計 */
export function limitSubjectUnitsOfDetail(items: readonly DetailItemLike[]): number {
  let t = 0;
  for (const it of items) {
    if (LIMIT_EXEMPT_PATTERN.test(String(it.service_content ?? ""))) continue;
    const u = Number(it.service_units ?? 0);
    if (Number.isFinite(u)) t += u;
  }
  return t;
}

/**
 * 限度額の判定に使う月の単位数と、その出どころ。
 * @param servicesUsed 利用票の行から積んだ値 (画面の usedUnits)
 * @param detailItems  同じ人・同じ月の第7表の items。無い・空なら利用票の行の値を使う
 */
export function usageLimitUnits(
  servicesUsed: number,
  detailItems: readonly DetailItemLike[] | null | undefined,
): { units: number; source: UsageLimitSource } {
  if (detailItems && detailItems.length > 0) return { units: limitSubjectUnitsOfDetail(detailItems), source: "service-usage-detail" };
  return { units: servicesUsed, source: "services" };
}
