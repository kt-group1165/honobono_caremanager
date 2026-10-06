/**
 * 支給量を丸ごと超えた訪問を決める (純関数)。aggregate.ts の 3.95) から呼ぶ。
 *
 * ── ほのぼのの実伝送 (2026-06 全 17 拠点の TJ) で確かめた規則 ──────────────
 *   ① 1 人換算の算定時間が支給量を超える請求は 0 名。
 *      いすみ 宮本菜々: 家事 支給量 10.5h。月末 6/30 の家事 0.5h を請求せず 10.5h ちょうどで止めた
 *   ② ・２人 (2 人目) の時間は数えない。
 *      いすみ 尾崎昌代: 家事 1 人換算 16h / 2 人分込み 31.5h / 支給量 20h → 31.5h 全額請求
 *   ③ 訪問の途中で支給量に達する場合は実例が無く未確認 → 外さない (呼出側で警告)
 *
 * 検証: npm run check:shikyuryo-cap
 */

/** 1 訪問を構成する請求行 (基本・増・・２人) */
export interface CapRow {
  /** サービス名から求めた算定時間 (分) */
  billedMinutes: number;
  /** ・２人 (2 人目のヘルパー分) */
  secondHelper: boolean;
}

export interface CapPlan {
  /** 開始時点で既に支給量に達していた訪問 (= 丸ごと外す)。キーは呼出側の訪問キー */
  cut: string[];
  /** 訪問の途中で支給量に達した訪問 (外さない。警告用) */
  straddle: string[];
  /** 外した後の 1 人換算の合計 (分) */
  usedMinutes: number;
}

/**
 * @param visits 訪問キー → その訪問の請求行。キーは **日付・開始時刻順に並ぶ文字列** にすること
 *               (例 "2026-06-30|14:30")。キーの昇順で積む
 * @param capMinutes 支給量 (分)。0 以下は「判定しない」
 */
export function planShikyuryoCut(visits: Map<string, CapRow[]>, capMinutes: number): CapPlan {
  const plan: CapPlan = { cut: [], straddle: [], usedMinutes: 0 };
  if (!(capMinutes > 0)) return plan;
  for (const key of [...visits.keys()].sort()) {
    const rows = visits.get(key)!;
    const mins = rows.filter((r) => !r.secondHelper).reduce((a, r) => a + r.billedMinutes, 0);
    if (plan.usedMinutes >= capMinutes) {
      plan.cut.push(key);
      continue;
    }
    if (plan.usedMinutes + mins > capMinutes) plan.straddle.push(key);
    plan.usedMinutes += mins;
  }
  return plan;
}

/** サービス名 (家事日０．５ / 身体日２．５・夜０．５ / 家事夜増２．０ / 通院１日４．０ 等) の算定時間 (分)。引けなければ null */
export function billedMinutesFromName(name: string): number | null {
  const segs = [...name.normalize("NFKC").matchAll(/(?:日|夜|深|早)増?(\d+(?:\.\d+)?)/g)];
  if (!segs.length) return null;
  return Math.round(segs.reduce((a, m) => a + Number(m[1]), 0) * 60);
}
