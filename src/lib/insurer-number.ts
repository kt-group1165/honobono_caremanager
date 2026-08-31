/**
 * 介護保険の保険者番号 (6 桁) の検証。
 *
 * ── 構成 ────────────────────────────────────────────────────────────────
 *   [JIS の市区町村コード 5 桁][検証数字 1 桁]
 *   例) 12219 市原市 + 2 = 122192 / 12206 木更津市 + 9 = 122069
 *
 * ── 検証数字の作り方 (modulus10) ────────────────────────────────────────
 *   1. 5 桁を左から重み 2,1,2,1,2 で掛ける
 *   2. 積が 2 桁になったら十の位と一の位を足す (9 を超えたぶんを畳む)
 *   3. 合計の下 1 桁を 10 から引く。10 になったら 0
 *
 * ⚠ 全国地方公共団体コードの検証数字は **modulus11** で別物。混同すると
 *   1 桁ずれる (feedback_shogai_shichoson_number)。障害の市町村番号は
 *   こちらと同じ modulus10 だが、介護は区ごと・障害は市ごとに付番されるので
 *   **対応表を流用してはいけない** (千葉市: 介護 121012=中央区 / 障害 121004=千葉市)。
 *
 * ── 何のために使うか ────────────────────────────────────────────────────
 *   伝送の証記載保険者番号が誤っていると返戻になる。生成時に警告を出して
 *   気づけるようにするためのもの。**自動で直さない** — 正しい番号は
 *   被保険者証を見ないと決められないため。
 *
 *   実例 (2026-08-31): ほのぼのが 木更津市の 3 名を "001220" で請求していた
 *   (正しくは 122069)。当方の伝送 17,179 明細行を検算して見つかったのは
 *   この 1 種類だけ。
 */

/** 保険者番号 6 桁のうち、先頭 5 桁から検証数字 (6 桁目) を求める */
export function insurerCheckDigit(five: string): number | null {
  if (!/^\d{5}$/.test(five)) return null;
  const weights = [2, 1, 2, 1, 2];
  let sum = 0;
  for (let i = 0; i < 5; i++) {
    let v = Number(five[i]) * weights[i];
    if (v > 9) v = Math.floor(v / 10) + (v % 10);
    sum += v;
  }
  const r = 10 - (sum % 10);
  return r === 10 ? 0 : r;
}

/** 保険者番号として成立しているか (6 桁 + 検証数字が合う) */
export function isValidInsurerNumber(num: string | null | undefined): boolean {
  const n = (num ?? "").trim();
  if (!/^\d{6}$/.test(n)) return false;
  return String(insurerCheckDigit(n.slice(0, 5))) === n[5];
}

/**
 * 伝送生成時の警告文。問題なければ null。
 * @param label 利用者名など、どの行の話か分かる文字列
 */
export function insurerNumberWarning(num: string | null | undefined, label: string): string | null {
  const n = (num ?? "").trim();
  if (!n) return null;                       // 未登録は呼出側が別途警告している
  if (!/^\d{6}$/.test(n)) {
    return `${label}: 保険者番号 "${n}" が 6 桁の数字ではありません — このまま伝送すると返戻になります`;
  }
  const expected = insurerCheckDigit(n.slice(0, 5));
  if (String(expected) !== n[5]) {
    return (
      `${label}: 保険者番号 "${n}" は検証数字が合いません ` +
      `(先頭5桁 ${n.slice(0, 5)} なら末尾は ${expected}) — 被保険者証を確認してください。` +
      `このまま伝送すると返戻になります`
    );
  }
  return null;
}
