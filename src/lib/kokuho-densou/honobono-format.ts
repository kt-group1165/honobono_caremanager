/**
 * 伝送レコードを **ほのぼのの実伝送と同じ書式**に整える。
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────
 *   値はすべて一致していても、書式が 3 点違っていた (2026-08-07 四街道で確認):
 *     ① 引用符   ほのぼのは一部の項目を "7131" "1000656874" と括る
 *     ② 0 埋め   ほのぼのは使わない数値項目に 0 を書く (当方は空欄だった)
 *     ③ 並び順   ほのぼのは 保険者番号+被保険者番号 の昇順 (当方は未ソート)
 *   仕様上どちらでも通るはずだが、取込テストの一発合格と
 *   「差分ゼロ」で照合できる状態を優先して合わせる。
 *
 * ── 根拠 ──────────────────────────────────────────────────────────────
 *   ほのぼのの実伝送 **112 ファイル** (18 拠点 / 介護給付・総合事業) を解析し、
 *   レコード種別ごとに「常に引用符が付く項番」「常に 0 が入る項番」を抽出した。
 *   全ファイルで完全に一貫していた (拠点差・月差なし)。
 *   ⚠ 値のある項目には触れない。**空欄のときだけ** 0 を書く。
 *     ほのぼのが空欄の項目に当方が値を入れているケースは無い (全項目照合で確認済)。
 */

/** 項番 (1 始まり) → 配列 index (0 始まり) */
const idx = (...items: number[]) => new Set(items.map((n) => n - 1));
/** from..to の項番を展開 */
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

type Rule = {
  /** 引用符で括る項番 */
  quote: Set<number>;
  /** 空欄なら "0" を書く項番 */
  zero: Set<number>;
};

/**
 * キー = 交換情報識別番号 + (請求書は "" / 明細書はレコード種別)。
 * 項番は IF 仕様の項番 (レコード内の 1 始まり。行番号 2 列は含まない)。
 *
 * zero = 「ほのぼのの実伝送で **一度も空欄にならず、かつ全ての値が数字**の項番」。
 *   0 埋めの対象はここから機械的に決めている。0 を書くのは**当方が空欄のときだけ**。
 *   ⚠ 抽出条件を 2 回間違えたので経緯を残す:
 *     1) 「常に 0 の項」だけを拾う → 公費欄のように「0 の人と値がある人が混在する項」を
 *        取りこぼした (7131-02 の項11・15 が空欄のまま)。
 *     2) 「空欄ゼロ」だけで拾う → **カナ等の文字項目まで対象**になり、当方が空のときに
 *        氏名カナが "0" になった (J121-01 項8 支給決定者氏名カナ)。
 *     → 「空欄ゼロ **かつ** 全て数字」が正しい条件。文字項目は空のままにする。
 */
const RULES: Record<string, Rule> = {
  // ── 介護保険 (7111/7113 請求書 / 7131・71R1 明細書) ──
  "7111": { quote: idx(1), zero: idx(...range(1, 18)) },
  "7113": { quote: idx(1), zero: idx(1, 2, ...range(4, 12)) },

  "7131-01": {
    quote: idx(1, 6),
    zero: idx(...range(1, 5), 13, 14, 15, 17, 18, 19, 29, ...range(33, 56)),
  },
  "71R1-01": {
    quote: idx(1, 6),
    zero: idx(2, 3, 5, 13, 14, 15, 17, 19, 20, ...range(33, 56)),
  },

  // 項18 = 摘要。常に "" (空の引用符) で出るので 0 埋め対象外
  "7131-02": { quote: idx(1, 6, 18), zero: idx(...range(1, 5), ...range(7, 17)) },
  "71R1-02": { quote: idx(1, 6, 18), zero: idx(2, 3, 5, ...range(8, 17)) },

  "7131-10": { quote: idx(1, 6), zero: idx(...range(1, 5), ...range(7, 11), ...range(14, 26)) },
  "71R1-10": { quote: idx(1, 6), zero: idx(2, 3, 5, ...range(8, 11), ...range(14, 26)) },

  // ── 障害福祉サービス (J11 請求書・明細書 / J61 実績記録票 / J41 上限管理結果票) ──
  //   J121-01 の項8/9 (氏名カナ) と項14 は文字項目なので 0 埋めしない。
  "J111-01": { quote: idx(1), zero: idx(...range(2, 10), 12, ...range(17, 20), 22) },
  "J111-02": { quote: idx(1), zero: idx(...range(2, 11), 13) },

  "J121-01": { quote: idx(1, 6, 8, 9, 14), zero: idx(...range(2, 6), ...range(10, 13), ...range(20, 22), 27, 28) },
  "J121-02": { quote: idx(1, 6), zero: idx(...range(2, 8), 10) },
  "J121-03": { quote: idx(1, 6, 11), zero: idx(...range(2, 6), 8, 9, 10) },
  "J121-04": { quote: idx(1, 6), zero: idx(...range(2, 16), 21, 22) },
  "J121-05": { quote: idx(1, 6), zero: idx(...range(2, 9), 11) },

  "J411-01": { quote: idx(1, 7, 8, 9), zero: idx(...range(2, 7), ...range(10, 14)) },
  "J411-02": { quote: idx(1, 6), zero: idx(...range(2, 11)) },
  "J421-01": { quote: idx(1, 7, 8, 9), zero: idx(...range(2, 7), ...range(10, 14)) },
  "J421-02": { quote: idx(1, 6, 12, 13), zero: idx(...range(2, 12)) },

  "J611-01": { quote: idx(1, 6), zero: idx(...range(2, 7)) },
  "J611-02": { quote: idx(1, 6), zero: idx(...range(2, 9), 14, 15, 19) },
};

/** 請求書 (7111/7113) はレコード種別列を持たないのでキーは識別番号のみ */
const isSeikyusho = (kokanId: string) => kokanId === "7111" || kokanId === "7113";

function ruleFor(parts: string[]): Rule | null {
  const kokanId = parts[0] ?? "";
  const key = isSeikyusho(kokanId) ? kokanId : `${kokanId}-${parts[1] ?? ""}`;
  return RULES[key] ?? null;
}

/**
 * 1 レコード分の項目配列を ほのぼの書式に整える。
 * 未知のレコード種別はそのまま返す (勝手に書式を変えない)。
 */
export function formatRecordLikeHonobono(parts: string[]): string[] {
  const rule = ruleFor(parts);
  if (!rule) return parts;
  return parts.map((v, i) => {
    const s = v ?? "";
    // ① 0 埋め: **空欄のときだけ**。値があれば触らない
    const filled = s === "" && rule.zero.has(i) ? "0" : s;
    // ② 引用符: 既に括られていれば二重にしない
    if (!rule.quote.has(i)) return filled;
    return /^".*"$/.test(filled) ? filled : `"${filled}"`;
  });
}

/**
 * 明細書の並び順を ほのぼの に合わせる比較関数。
 * **保険者番号 + 被保険者番号 の昇順** (どちらも文字列比較。前0埋め済みの前提)。
 *
 * 請求書 (7111/7113) は利用者単位ではないので対象外 —
 * 呼び出し側で「明細書を作る前の rows」に対して使うこと。
 */
export function compareByInsurer(
  a: { insurer_number?: string | null; insured_number?: string | null },
  b: { insurer_number?: string | null; insured_number?: string | null },
): number {
  const k = (r: { insurer_number?: string | null; insured_number?: string | null }) =>
    `${(r.insurer_number ?? "").trim().padStart(8, "0")}|${(r.insured_number ?? "").trim()}`;
  return k(a).localeCompare(k(b));
}
