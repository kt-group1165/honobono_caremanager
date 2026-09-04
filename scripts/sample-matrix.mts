/**
 * サンプルデータの **組合せ生成** (pairwise / 2 因子間網羅)   ★ READ ONLY・DB を触らない
 *
 *   npx tsx scripts/sample-matrix.mts                     制度ごとのサマリ + 介護保険のケース表
 *   npx tsx scripts/sample-matrix.mts --system shogai     その制度のケース表
 *   npx tsx scripts/sample-matrix.mts --system kyotaku --json out.json   投入 script に渡す
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   これまでのサンプル検証は **人が思いついた組合せ**を 1 本ずつ書いていた。
 *   見つかったバグは本物だが、★ 「どこまで見たか」を数字で言えない。
 *   因子を列挙して機械的に生成すれば、★ 網羅率が数字になる。
 *
 * ⚠ 全組合せ (直積) は現実的でないので **2 因子間の全ペアを 1 回以上通す** (pairwise)。
 *   相互作用のバグは大半が 2 因子の組合せで出る、という経験則に基づく。
 *   ★ 3 因子でしか出ないバグは この方法では拾えない。そこは自覚して使う。
 *
 * ⚠ 因子の定義は **scripts/_factors.mts に 1 か所だけ**置く。
 *   2026-09-04 まで このファイルと coverage-check.mts が別々に定義していて、
 *   ★ 分母が違う数字 (474ペア / 285ペア) を同じ土俵のように並べていた。
 *   分母は必ず pairKeysFor() から取ること。
 */

import { writeFileSync } from "node:fs";
import {
  FACTOR_SPEC_SETS,
  pairKeysForSpec,
  type FactorSpecSet,
} from "./_factors.mjs";

type NamedValues = { name: string; values: readonly string[] };

/**
 * pairwise を組む。
 * ★ 「まだ覆えていないペアを 1 つ選び、その 2 因子を固定して残りを貪欲に埋める」。
 *   こうすると 1 ケースで必ず 1 組以上消えるので ★ 必ず終わる。
 *   (先に全因子を貪欲に選ぶ方式にしたら、消せるペアが 0 のケースを作って止まった)
 */
function buildPairwise(fs: NamedValues[], pairs: string[]): string[][] {
  const need = new Set(pairs);
  const cases: string[][] = [];
  const pairsOf = (c: string[]) => {
    const out: string[] = [];
    for (let i = 0; i < c.length; i++)
      for (let j = i + 1; j < c.length; j++) out.push(`${i}:${c[i]}|${j}:${c[j]}`);
    return out;
  };
  while (need.size > 0) {
    // 未消化のペアを 1 つ取り、その 2 因子を固定する
    const seed = need.values().next().value as string;
    const m = /^(\d+):(.*)\|(\d+):(.*)$/.exec(seed);
    if (!m) throw new Error(`ペアの形式が壊れています: ${seed}`);
    const fixed = new Map<number, string>([[Number(m[1]), m[2]], [Number(m[3]), m[4]]]);
    const c: string[] = [];
    for (let i = 0; i < fs.length; i++) {
      const f = fixed.get(i);
      if (f !== undefined) { c.push(f); continue; }
      // 残りは「すでに決めた因子との間で未消化ペアを最も多く消す値」
      let pick = fs[i].values[0];
      let gain = -1;
      for (const v of fs[i].values) {
        let g = 0;
        for (let k = 0; k < c.length; k++) if (need.has(`${k}:${c[k]}|${i}:${v}`)) g++;
        if (g > gain) { gain = g; pick = v; }
      }
      c.push(pick);
    }
    const cleared = pairsOf(c).filter((x) => need.has(x));
    if (cleared.length === 0) throw new Error("1 組も消せないケースが出ました (生成器のバグ)");
    cases.push(c);
    for (const x of cleared) need.delete(x);
  }
  return cases;
}

/** 生成したケース集合が本当に全ペアを覆っているか + ★ 負のコントロール */
function selfCheck(set: FactorSpecSet, cases: string[][], pairs: string[]): void {
  const seenOf = (list: string[][]) => {
    const seen = new Set<string>();
    for (const c of list)
      for (let i = 0; i < c.length; i++)
        for (let j = i + 1; j < c.length; j++) seen.add(`${i}:${c[i]}|${j}:${c[j]}`);
    return seen;
  };
  const seen = seenOf(cases);
  const missing = pairs.filter((p) => !seen.has(p));
  if (missing.length) {
    console.error(`★ FAIL ${set.key}: 覆えていないペアが ${missing.length} 件: ${missing.slice(0, 5).join(" / ")}`);
    process.exit(1);
  }
  // ★ 負のコントロール: 1 ケース抜いたら必ず穴が開くこと
  //   (抜いても覆えているなら、そのケースは無駄 = 生成器のバグ)
  const seen2 = seenOf(cases.slice(0, -1));
  if (pairs.every((p) => seen2.has(p))) {
    console.error(`★ FAIL ${set.key}: 最後のケースを抜いても全ペアを覆えている = 冗長なケースを出している`);
    process.exit(1);
  }
}

/* ── 実行 ────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const argOf = (flag: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const wantKey = argOf("--system") ?? "kaigo";
const target = FACTOR_SPEC_SETS.find((s) => s.key === wantKey);
if (!target) {
  console.error(`★ --system は ${FACTOR_SPEC_SETS.map((s) => s.key).join(" / ")} のいずれか (指定: ${wantKey})`);
  process.exit(1);
}

console.log("── 制度ごとの分母 (★ coverage-check.mts と同じ pairKeysFor() で数えている)");
console.log(`   ${"key".padEnd(9)}${"因子".padEnd(5)}${"直積".padEnd(14)}${"2因子ペア".padEnd(11)}${"pairwise ケース".padEnd(16)}未測定の因子`);
for (const s of FACTOR_SPEC_SETS) {
  const pairs = pairKeysForSpec(s);
  const cases = buildPairwise(s.factors, pairs);
  selfCheck(s, cases, pairs);
  const product = s.factors.reduce((a, f) => a * f.values.length, 1);
  const unmeasured = s.factors.filter((f) => !f.measurable).map((f) => f.name);
  console.log(
    `   ${s.key.padEnd(9)}${String(s.factors.length).padEnd(5)}${product.toLocaleString().padEnd(14)}`
    + `${String(pairs.length).padEnd(11)}${String(cases.length).padEnd(16)}`
    + (unmeasured.length ? `★ ${unmeasured.join(" / ")}` : "—"),
  );
}
console.log("");
console.log(`制約 (有り得ない組合せ) は全制度で ${FACTOR_SPEC_SETS.reduce((a, s) => a + s.constraints.length, 0)} 件 ★ 未検証`);
console.log("  → 空のままだと成立しない組合せも生成されます。根拠が言えるものだけ _factors.mts に足すこと。");
console.log("⚠ 3 因子でしか出ないバグはこの方法では拾えません。");
console.log("⚠ ★ 未測定の因子は、生成はできても **実データ側では網羅率を数えられません**。");
console.log("");

const pairs = pairKeysForSpec(target);
const cases = buildPairwise(target.factors, pairs);
console.log(`━━ ${target.system}`);
if (target.note) console.log(`   ⚠ ${target.note}`);
console.log(`   2因子間のペア ${pairs.length.toLocaleString()} 組 → ★ ${cases.length} ケースで全部通る`);
console.log("");

if (argv.includes("--json")) {
  const out = argOf("--json");
  if (!out) { console.error("★ --json の後にファイル名がありません"); process.exit(1); }
  const rows = cases.map((c, i) =>
    Object.fromEntries([
      ["case", `${target.key.toUpperCase().slice(0, 2)}${String(i + 1).padStart(3, "0")}`],
      ...c.map((v, k) => [target.factors[k].name, v] as const),
    ]),
  );
  writeFileSync(out, JSON.stringify(rows, null, 2) + "\n", "utf8");
  console.log(`→ ${out} に ${rows.length} ケースを書きました`);
} else {
  const w = target.factors.map((f) => Math.max(f.name.length, ...f.values.map((v) => v.length)));
  console.log("     " + target.factors.map((f, i) => f.name.padEnd(w[i])).join(" "));
  cases.forEach((c, i) => console.log(`M${String(i + 1).padStart(3, "0")} ` + c.map((v, k) => v.padEnd(w[k])).join(" ")));
}
