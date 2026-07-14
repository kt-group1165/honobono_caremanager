/**
 * 移動支援 (千葉市地域生活支援給付) の算定コード解決
 *
 * 制度定義: migrations/_if_idou_shien_chiba.txt (千葉市 R6.4.1 適用コード表が正)
 *
 * - 時間帯: 深夜 22:00-6:00 / 早朝 6:00-8:00 / 日中 8:00-18:00 / 夜間 18:00-22:00
 * - 単一時間帯に収まる場合のみここでコード解決する。
 *   時間帯を跨ぐ場合は複合コード (別系列) が必要で Phase 2 (算定エンジン) で対応。
 *   その場合 null を返し、UI 側で「複合時間帯」警告を出す。
 * - 運転中など常時支援でない時間は控除した「算定時間」でコード区分を決める。
 * - 1 単位 = 10 円固定。
 */

export type IdouBand = "日中" | "早朝" | "夜間" | "深夜";

/** 移動1 (身体介護を伴う) 基準単位: 30分刻み 0.5h〜10.5h の 21 区分 */
const BASE_UNITS_BODY = [
  280, 441, 640, 730, 822, 913, 1004, 1095, 1186, 1277, 1368,
  1459, 1550, 1641, 1732, 1823, 1914, 2005, 2096, 2187, 2278,
];
/** 移動2 (身体介護を伴わない) 基準単位 */
const BASE_UNITS_NO_BODY = [
  116, 215, 300, 377, 453, 529, 605, 681, 757, 833, 909,
  985, 1061, 1137, 1213, 1289, 1365, 1441, 1517, 1593, 1669,
];

/** 時間帯ごとの掛率と、コード系列の開始番号・最大区分数 (千葉市コード表 R6.4.1) */
const SERIES: Record<
  IdouBand,
  { mult: number; maxBrackets: number; startBody: number; startNoBody: number }
> = {
  // 系列はコード 4 刻み (単独 / ・2人 ペアで +1)
  日中: { mult: 1.0, maxBrackets: 21, startBody: 23111, startNoBody: 27111 },
  早朝: { mult: 1.25, maxBrackets: 5, startBody: 23195, startNoBody: 27195 },
  夜間: { mult: 1.25, maxBrackets: 9, startBody: 23215, startNoBody: 27215 },
  深夜: { mult: 1.5, maxBrackets: 13, startBody: 23251, startNoBody: 27251 },
};

const toMin = (t: string): number => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

/** その時刻が属する時間帯 (開始時刻基準)。深夜は 22:00-24:00 と 0:00-6:00 の両側 */
export function bandOf(minOfDay: number): IdouBand {
  if (minOfDay < 6 * 60) return "深夜";
  if (minOfDay < 8 * 60) return "早朝";
  if (minOfDay < 18 * 60) return "日中";
  if (minOfDay < 22 * 60) return "夜間";
  return "深夜";
}

export interface IdouCodeResult {
  code: string;
  /** 2人目従業者用コード (派遣人数 2 のとき 2 行目として請求する) */
  code2nd: string;
  band: IdouBand;
  bracket: number; // 1 = 〜30分, 2 = 〜1時間, ...
  units: number; // 合成単位数 (時間帯掛率込み、1人分)
  label: string; // 例: 移動1日中2.0
}

export type IdouResolveError =
  | { reason: "no_time" } // 時刻未入力
  | { reason: "invalid_range" } // 終了 <= 開始 等
  | { reason: "cross_band"; bands: IdouBand[] } // 時間帯跨ぎ → 複合コード (Phase 2)
  | { reason: "over_max"; band: IdouBand; maxBrackets: number }; // 系列の上限区分超過

/**
 * 実績開始/終了時刻と控除分から単一時間帯コードを解決する。
 * 日跨ぎ (終了 < 開始) は深夜帯 22:00→翌6:00 の範囲のみ許容する。
 */
export function resolveIdouCode(
  startTime: string,
  endTime: string,
  deductMinutes: number,
  withBodyCare: boolean,
): IdouCodeResult | IdouResolveError {
  if (!startTime || !endTime) return { reason: "no_time" };
  const s = toMin(startTime);
  let e = toMin(endTime);
  let crossesMidnight = false;
  if (e <= s) {
    // 日跨ぎ: 深夜帯 (22時以降開始 → 翌6時まで) のみ同一「深夜」として扱う
    if (s >= 22 * 60 && e <= 6 * 60) {
      e += 24 * 60;
      crossesMidnight = true;
    } else {
      return { reason: "invalid_range" };
    }
  }

  const startBand = bandOf(s);
  // 終了時刻は「その時点まで提供」なので直前の分で帯判定 (18:00 終了は日中扱い)
  const endBand = crossesMidnight ? "深夜" : bandOf(e - 1);
  if (startBand !== endBand) {
    return { reason: "cross_band", bands: [startBand, endBand] };
  }

  const calcMin = e - s - Math.max(0, deductMinutes);
  if (calcMin <= 0) return { reason: "invalid_range" };

  const series = SERIES[startBand];
  const bracket = Math.ceil(calcMin / 30);
  if (bracket > series.maxBrackets) {
    return { reason: "over_max", band: startBand, maxBrackets: series.maxBrackets };
  }

  const base = (withBodyCare ? BASE_UNITS_BODY : BASE_UNITS_NO_BODY)[bracket - 1];
  const units = Math.round(base * series.mult);
  const start = withBodyCare ? series.startBody : series.startNoBody;
  const codeNum = start + (bracket - 1) * 4;
  const hours = (bracket * 0.5).toFixed(1);
  const prefix = withBodyCare ? "移動1" : "移動2";
  return {
    code: `0${codeNum}`,
    code2nd: `0${codeNum + 1}`,
    band: startBand,
    bracket,
    units,
    label: `${prefix}${startBand}${hours}`,
  };
}

/** 算定時間 (分) = 実績時間 − 控除。表示用 */
export function calcMinutes(
  startTime: string,
  endTime: string,
  deductMinutes: number,
): number | null {
  if (!startTime || !endTime) return null;
  const s = toMin(startTime);
  let e = toMin(endTime);
  if (e <= s) {
    if (s >= 22 * 60 && e <= 6 * 60) e += 24 * 60;
    else return null;
  }
  const m = e - s - Math.max(0, deductMinutes);
  return m > 0 ? m : null;
}

/** 訪問入浴 (地域生活支援給付) のコード解決 */
export function resolveChiikiBathCode(kaigoStaff3: boolean, aborted: boolean): string {
  if (aborted) return kaigoStaff3 ? "041121" : "041120";
  return kaigoStaff3 ? "041111" : "041110";
}
