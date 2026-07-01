/**
 * 条 / 項 / 号 の番号 render helper
 *
 * docx 原本に合わせて:
 *   - 条 = 「第１条」〜「第２２条」  (全角数字)
 *   - 項 = ①〜⑳
 *   - 号 = ・ (nakaguro) / イロハ / 1.2.3.
 */

const HANKAKU_TO_ZENKAKU_DIGIT: Record<string, string> = {
  "0": "０",
  "1": "１",
  "2": "２",
  "3": "３",
  "4": "４",
  "5": "５",
  "6": "６",
  "7": "７",
  "8": "８",
  "9": "９",
};

export function toZenkakuDigits(n: number): string {
  return String(n)
    .split("")
    .map((c) => HANKAKU_TO_ZENKAKU_DIGIT[c] ?? c)
    .join("");
}

export function articleLabel(index: number): string {
  return `第${toZenkakuDigits(index + 1)}条`;
}

const CIRCLED_NUMBERS =
  "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚";

/**
 * 項の marker を返す。
 * - 'circled' → ①②③... (docx で明示 marker がある場合)
 * - 'none' → 空文字 (docx 無番号項に対応。段落として visually 区切るだけ)
 */
export function paragraphMarker(
  index: number,
  style: "circled" | "none" = "circled",
): string {
  if (style === "none") return "";
  return CIRCLED_NUMBERS[index] ?? `(${index + 1})`;
}

const IROHA = "イロハニホヘトチリヌルヲワカヨタレソツネナラム";

export function itemMarker(
  index: number,
  style: "nakaguro" | "iroha" | "arabic",
): string {
  switch (style) {
    case "nakaguro":
      return "・";
    case "iroha":
      return IROHA[index] ?? `(${index + 1})`;
    case "arabic":
      return `${index + 1}.`;
  }
}
