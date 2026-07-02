/**
 * サービス名の 全角/半角 数字ゆれ を吸収する helper
 *
 * 背景:
 *   kaigo_service_codes.service_name は厚労省 CSV 由来で全角数字 (身体介護３)。
 *   kaigo_visit_schedule.service_type は UI 入力/migration で半角 (身体介護3) が混在。
 *   → 単位数 lookup 時に不一致で units が引けない事故が起きるため、
 *     .in() の候補に両表記を含める + 正規化キーで map を引く。
 */

const Z2H: Record<string, string> = {
  "０": "0", "１": "1", "２": "2", "３": "3", "４": "4",
  "５": "5", "６": "6", "７": "7", "８": "8", "９": "9",
};
const H2Z: Record<string, string> = {
  "0": "０", "1": "１", "2": "２", "3": "３", "4": "４",
  "5": "５", "6": "６", "7": "７", "8": "８", "9": "９",
};

/** 数字を半角に統一 (正規化キーとして使う) */
export function toHankakuDigits(s: string): string {
  return s.replace(/[０-９]/g, (ch) => Z2H[ch] ?? ch);
}

/** 数字を全角に統一 */
export function toZenkakuDigits(s: string): string {
  return s.replace(/[0-9]/g, (ch) => H2Z[ch] ?? ch);
}

/** lookup 用: 元表記 + 全角化 + 半角化 の unique な候補配列 */
export function serviceNameVariants(name: string): string[] {
  return Array.from(new Set([name, toZenkakuDigits(name), toHankakuDigits(name)]));
}

/**
 * 複数サービス名の .in() 候補 (全 variants を flatten + unique)
 */
export function serviceNameVariantsAll(names: string[]): string[] {
  const set = new Set<string>();
  for (const n of names) {
    for (const v of serviceNameVariants(n)) set.add(v);
  }
  return Array.from(set);
}
