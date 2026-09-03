// ============================================================================
// ほのぼの伝送 KK から 保険給付率 を読む共有 module。
//
//   様式 7131 (介護給付費明細書) 項29 = 保険給付率。
//   ⚠ 居宅の 8124 には保険給付率の項目が **無い**。居宅しか使っていない利用者は
//     原理的に判定できない。取りこぼしではない。
//
//   ⚠ .mts (scripts/check-benefit-vs-densou.mts) と .mjs (migrations/fix_*.mjs) の
//     両方から使うのでここに置く。逐語コピーすると片方だけ直る事故になる。
//     (feedback_test_verbatim_copy_and_wrong_expectation)
// ============================================================================
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** 解説CSV (*_解説.csv) を再帰で集める */
export function findKaisetsuFiles(dir, out = []) {
  let ents;
  try { ents = readdirSync(dir); } catch { return out; }
  for (const e of ents) {
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) findKaisetsuFiles(p, out);
    else if (/^KK.*_解説\.csv$/i.test(e)) out.push(p);
  }
  return out;
}

const dec = new TextDecoder("shift_jis");

/**
 * 伝送から (保険者末尾6桁|被保険者番号|提供年月) → 給付率の集合 を作る。
 *
 *   ⚠ 保険者番号は 伝送が 8桁 前0埋め (00121012) / 当方が 6桁 (121012)。
 *     **末尾6桁**で合わせる。
 *   ⚠ 被保険者番号は保険者の中でしか一意でないので、必ず対で引く。
 *
 * @returns {{ map: Map<string, Set<string>>, files: number, records: number }}
 */
export function loadDensouBenefitRates(root) {
  const map = new Map();
  let files = 0;
  let records = 0;
  for (const f of findKaisetsuFiles(root)) {
    const text = dec.decode(readFileSync(f));
    // 解説CSV の 1 行は  レコード番号,項番,項目名,="値",注記
    const byRec = new Map();
    for (const line of text.split(/\r?\n/)) {
      const m = /^(\d+),(\d+),[^,]*,="([^"]*)"/.exec(line);
      if (!m) continue;
      const rid = Number(m[1]);
      if (!byRec.has(rid)) byRec.set(rid, new Map());
      byRec.get(rid).set(Number(m[2]), m[3]);
    }
    let used = false;
    for (const v of byRec.values()) {
      if (v.get(1) !== "7131") continue;
      const ym = v.get(3) ?? "";
      const insurer = (v.get(5) ?? "").slice(-6);
      const insured = v.get(6) ?? "";
      const rate = v.get(29) ?? "";
      if (!ym || !insurer || !insured || !rate) continue;
      records += 1;
      used = true;
      const k = `${insurer}|${insured}|${ym}`;
      if (!map.has(k)) map.set(k, new Set());
      map.get(k).add(rate);
    }
    if (used) files += 1;
  }
  return { map, files, records };
}

/**
 * benefit_rate は **単位が混在**している。9 / 8 / 7 は「割」で入っていて
 * 90 / 80 / 70 と同義。正規化せずに比べると矛盾を 46 行ほど水増しする。
 */
export const benefitPct = (b) => (b > 0 && b <= 10 ? b * 10 : b);

/** 負担割合 → 給付率 (1割→90 / 2割→80 / 3割→70) */
export const benefitFromCopay = (c) => 100 - c * 10;

/** その認定の有効期間に重なる提供年月のうち、伝送に出ているものの給付率 */
export function densouRatesFor(map, cert) {
  const rates = new Set();
  const ins6 = String(cert.insurer_number ?? "").slice(-6);
  const num = String(cert.insured_number ?? "");
  if (!ins6 || !num) return rates;
  for (const [k, v] of map) {
    const [i, n, ym] = k.split("|");
    if (i !== ins6 || n !== num) continue;
    const first = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-01`;
    const last = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-28`;
    if (cert.certification_start_date && cert.certification_start_date > last) continue;
    if (cert.certification_end_date && cert.certification_end_date < first) continue;
    for (const r of v) rates.add(r);
  }
  return rates;
}
