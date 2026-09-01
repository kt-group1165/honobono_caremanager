// ============================================================================
// 利用者データ (基本情報 / 介護保険1 / 公費1) の置き場所を解決する共通ヘルパー。
//
// ── なぜ要るか ────────────────────────────────────────────────────────
//   6 月分だけを扱っていた頃は 利用者データ/<拠点>/ のフラット 1 段だった。
//   複数月を並行して検証するようになったので **月フォルダ**を持てるようにする。
//
//     利用者データ/<拠点>/<年月>/介護保険1.CSV   ← 月別 (これを優先)
//     利用者データ/<拠点>/介護保険1.CSV          ← 従来 (フォールバック)
//
//   既存 18 拠点はフラットのままなので、**両方読めること**が必須。
//
// ── ファイル名の揺れ ──────────────────────────────────────────────────
//   基本情報は ほのぼのの出力先によって名前が変わる:
//     基本情報_______.CSV   (既定。伏字は出力時の連番等)
//     基本情報1.CSV         (四街道 2026-07)
//   → 「基本情報」で始まる .CSV を拾う。複数あれば新しいものを採る。
// ============================================================================
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * 利用者データのディレクトリを解決する。
 * @param {string} kaigoRoot apps/kaigo-app のパス
 * @param {string} userSub   拠点フォルダ名 (例 "四街道")
 * @param {string} month     "2026-06" 形式。省略時は月フォルダを見ない
 * @returns {{dir:string, scoped:boolean}} scoped=true なら月フォルダを使った
 */
export function resolveUserDir(kaigoRoot, userSub, month) {
  const base = path.join(kaigoRoot, "利用者データ", userSub);
  if (month) {
    const ym = month.replace("-", ""); // 2026-06 -> 202606
    const scoped = path.join(base, ym);
    if (existsSync(scoped) && readdirSync(scoped).some((f) => /\.CSV$/i.test(f))) {
      return { dir: scoped, scoped: true };
    }
  }
  return { dir: base, scoped: false };
}

/**
 * 「基本情報」で始まる CSV を 1 本選ぶ (名前の揺れ吸収)。
 * @returns {string|null} フルパス
 */
export function findKihonCsv(dir) {
  let ents;
  try { ents = readdirSync(dir); } catch { return null; }
  const hits = ents
    .filter((f) => /^基本情報.*\.CSV$/i.test(f))
    .map((f) => path.join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return hits[0] ?? null;
}

/** 「介護保険1」「公費1」等も名前の揺れに備えて前方一致で探す */
export function findUserCsv(dir, prefix) {
  let ents;
  try { ents = readdirSync(dir); } catch { return null; }
  const pick = (p) => {
    const hits = ents
      .filter((f) => f.startsWith(p) && /\.CSV$/i.test(f))
      .map((f) => path.join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return hits[0] ?? null;
  };
  const exact = ents.find((f) => f === `${prefix}.CSV`);
  if (exact) return path.join(dir, exact);
  const hit = pick(prefix);
  if (hit) return hit;
  // ⚠ 出力元によっては連番の "1" が付かず「介護保険_<拠点名>.CSV」のような名前になることがある
  //   (Hana高品_登録有 で実例)。末尾の数字を落とした接頭辞でも探す。
  const base = prefix.replace(/\d+$/, "");
  return base !== prefix ? pick(base) : null;
}
