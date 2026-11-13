/**
 * 伝送 KY (居宅 給付管理票 / レコード種別 8222) の読み取り — 検査 scripts と migrations の共有 module
 *
 * kyotaku-k-diff.mts と riyouhyou-units-vs-ky.mts が同じ KY を読むため、
 * 行の分解・ファイル探索をここに 1 つだけ置く (逐語コピーすると片方だけ直したときに乖離する)。
 * ★ 2026-11-13 に .mts → .mjs (JSDoc) にした。node で動く migrations/fill_rental_units_from_betsuhyou.mjs からも使うため
 *   (中身は変えていない。.mts からは従来どおり "./_ky-parse.mjs" で import できる)
 *
 * 文字コード: KY は cp932。ここでは **latin1 で読む**。8222 の比較に使う項目
 * (年月・保険者番号・被保番・事業所番号・種類コード・単位数) はすべて ASCII なので
 * latin1 で失うものは無く、行を join し直せばバイト列も元に戻る (kyotaku-k-diff の突合が依存)。
 *
 * 8222 の項番 (0 始まり。2026-11-12 に K姉 KY260701.CSV + 同 _解説.csv で実測):
 *   c[0]  "2" (データレコード)          c[2]  "8222"
 *   c[3]  対象年月 (YYYYMM)             c[4]  保険者番号
 *   c[5]  居宅介護支援事業所番号         c[9]  明細行番号 ("01".. / "99" = 合計行)
 *   c[10] 被保険者番号                  c[13] 要介護状態区分コード
 *   c[16] 合計行のみ: 区分支給限度基準額  c[18] サービス事業所番号
 *   c[20] サービス種類コード (2 桁)      c[21] 給付計画単位数
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** KY の 1 行を項目に分ける (クォートを外す)。
 * @param {string} line
 * @returns {string[]} */
export function splitKyLine(line) {
  return line.split(",").map((x) => x.replace(/^"(.*)"$/, "$1"));
}

/** ファイルを latin1 で読み、空行を除いた行の配列を返す。
 * @param {string} path
 * @returns {string[]} */
export function readKyLines(path) {
  return readFileSync(path, "latin1").split(/\r?\n/).filter((l) => l.trim() !== "");
}

/** 8222 のデータレコードか。
 * @param {string[]} c
 * @returns {boolean} */
export function is8222(c) {
  return c[0] === "2" && c[2] === "8222";
}

/**
 * dir 以下を再帰で探索し、KY*.CSV (解説ファイルを除く) を返す。
 * ym を指定すると、その対象年月の 8222 を 1 行でも含むファイルだけに絞る。
 * 月遅れ提出は翌月バッチの KY に入り、置き場所も ほのぼのから/ の外のことがあるため
 * 1 本決め打ちにしない (kyotaku-k-diff の経緯)。
 * @param {string} dir
 * @param {string} [ym]
 * @returns {string[]}
 */
export function findKyFiles(dir, ym) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} d */
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const q = join(d, e.name);
      if (e.isDirectory()) walk(q);
      else if (/^KY.*\.CSV$/i.test(e.name) && !e.name.includes("解説")) {
        if (!ym || readKyLines(q).some((l) => { const c = splitKyLine(l); return is8222(c) && c[3] === ym; })) out.push(q);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * @typedef {object} Ky8222Line
 * @property {string} ym
 * @property {string} insurer
 * @property {string} kyotakuOffice
 * @property {string} lineNo
 * @property {string} insured
 * @property {string} providerNumber
 * @property {string} serviceKind
 * @property {number} plannedUnits
 */

/** 8222 の明細行 (合計行 "99" を除く) を構造化して返す。ym 指定でその月だけ。
 * @param {string} path
 * @param {string} [ym]
 * @returns {Ky8222Line[]} */
export function readKy8222Lines(path, ym) {
  /** @type {Ky8222Line[]} */
  const out = [];
  for (const l of readKyLines(path)) {
    const c = splitKyLine(l);
    if (!is8222(c) || c[9] === "99") continue;
    if (ym && c[3] !== ym) continue;
    out.push({
      ym: c[3], insurer: c[4].trim(), kyotakuOffice: c[5], lineNo: c[9], insured: c[10].trim(),
      providerNumber: c[18], serviceKind: c[20], plannedUnits: Number(c[21] || 0),
    });
  }
  return out;
}
