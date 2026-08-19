/**
 * 請求書 (様式第一 / 総合事業 7113) の総括集計。
 *
 * 介護請求タブ (kaigo-seikyu-content.tsx) が持っていた集計を、国保請求タブ
 * (kokuho-seikyu-content.tsx) からも同じ数字で使えるように切り出したもの。
 * 計算内容は移設前と同一 — 変更するときは両画面の請求書が動くことに注意。
 *
 * 前提 (aggregate.ts の契約):
 *   - 公費単独 (被保険者番号 H = 生保 10割公費) は保険請求欄に記載しない。
 *     公費請求欄の生保行 (法別12) に合算する (様式第一の公式記載例準拠)。
 *   - 複数公費の併用行 (kohi2Amount あり) は公費1・公費2 をそれぞれの法別行に積む。
 */

import type { UserSeikyuRow } from "./aggregate";
import type {
  SeikyuKohiRow,
  SeikyuKohiTandoku,
} from "@/app/(authenticated)/billing/forms/_seikyu";

export interface SeikyuFormTotals {
  /** 保険請求分の行 (公費単独を除く) */
  hokenRows: UserSeikyuRow[];
  /** 件数 (= hokenRows.length) */
  totalCount: number;
  totalUnits: number;
  /** 費用合計 */
  totalAmount: number;
  insuranceAmount: number;
  /** 利用者負担 (法定負担のみ。限度額超過の全額自費は含まない) */
  userCopay: number;
  /** 保険請求分の公費請求額 合計 (公費1 + 公費2) */
  kohiRequestAmount: number;
  /** 公費請求テーブルの明細 (法別番号ごと) */
  kohiRows: SeikyuKohiRow[];
  /** 公費単独 (10割公費) の集計。無ければ undefined */
  kohiTandoku: SeikyuKohiTandoku | undefined;
}

/**
 * 請求書の総括集計を作る。
 *
 * @param rows 総括対象の行。様式第一 総括は「当月の通常行のみ」が対象
 *             (再請求分は元提供月の別請求書になるため呼出側で除外しておく)。
 */
export function buildSeikyuFormTotals(rows: UserSeikyuRow[]): SeikyuFormTotals {
  const hokenRows = rows.filter((r) => !r.kohiTandoku);
  const tandokuRows = rows.filter((r) => r.kohiTandoku);

  const kohiRequestAmount = hokenRows.reduce(
    (s, r) => s + (r.kohiAmount ?? 0) + (r.kohi2Amount ?? 0),
    0,
  );

  // 法別番号ごとに集計 (法別21/54 等の部分公費を生保行に混ぜない)。
  // 単位数・費用合計は公費対象分 (kohiUnits / kohiTargetCost。全量公費は総量と同値)。
  interface KohiEntry {
    units: number;
    cost: number;
    kohi: number;
  }
  const byHobetsu = new Map<string, KohiEntry[]>();
  const push = (hobetsu: string, e: KohiEntry) => {
    if (!byHobetsu.has(hobetsu)) byHobetsu.set(hobetsu, []);
    byHobetsu.get(hobetsu)!.push(e);
  };
  for (const r of hokenRows) {
    if ((r.kohiAmount ?? 0) > 0) {
      // 旧テキストのみの移行期データは生保扱い (aggregate と同基準)
      push(r.kohiHobetsu ?? "12", {
        units: r.kohiUnits ?? 0,
        cost: r.kohiTargetCost ?? r.totalAmount,
        kohi: r.kohiAmount ?? 0,
      });
    }
    if (r.kohi2Hobetsu && (r.kohi2Amount ?? 0) > 0) {
      push(r.kohi2Hobetsu, {
        units: r.kohi2Units ?? 0,
        cost: r.kohi2TargetCost ?? 0,
        kohi: r.kohi2Amount ?? 0,
      });
    }
  }
  const kohiRows: SeikyuKohiRow[] = Array.from(byHobetsu.entries()).map(
    ([code, es]) => ({
      code,
      count: es.length,
      units: es.reduce((s, e) => s + e.units, 0),
      cost: es.reduce((s, e) => s + e.cost, 0),
      kohi: es.reduce((s, e) => s + e.kohi, 0),
    }),
  );

  return {
    hokenRows,
    totalCount: hokenRows.length,
    totalUnits: hokenRows.reduce((s, r) => s + r.totalUnits, 0),
    totalAmount: hokenRows.reduce((s, r) => s + r.totalAmount, 0),
    insuranceAmount: hokenRows.reduce((s, r) => s + r.insuranceAmount, 0),
    userCopay: hokenRows.reduce((s, r) => s + r.userAmount, 0),
    kohiRequestAmount,
    kohiRows,
    // 公費単独分 (10割公費: 費用合計 = 公費請求額)
    kohiTandoku:
      tandokuRows.length > 0
        ? {
            count: tandokuRows.length,
            units: tandokuRows.reduce((s, r) => s + r.totalUnits, 0),
            cost: tandokuRows.reduce((s, r) => s + r.totalAmount, 0),
            kohi: tandokuRows.reduce((s, r) => s + (r.kohiAmount ?? 0), 0),
          }
        : undefined,
  };
}

/**
 * 様式第二 ④計画単位数 / ⑥限度額管理対象外単位数 の props を作る (契約 C1)。
 *   kanriTaishougaiUnits = 処遇改善等%加算 + 初回 + 緊急時 (限度額管理対象外)
 *   planUnits            = kaigo_monthly_plan_units があればそれ、
 *                          無ければ基準内 (管理対象) 単位数
 */
export function meisaiKanriProps(row: UserSeikyuRow): {
  kanriTaishougaiUnits: number;
  planUnits: number;
} {
  return {
    kanriTaishougaiUnits: row.kanriTaishougaiUnits,
    planUnits:
      row.planUnits ??
      row.baseUnits - (row.kanriTaishougaiUnits - row.addonUnits),
  };
}
