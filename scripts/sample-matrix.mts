/**
 * サンプルデータの **組合せ生成** (pairwise / 2 因子間網羅)   ★ READ ONLY・DB を触らない
 *
 *   npx tsx scripts/sample-matrix.mts            一覧と網羅率
 *   npx tsx scripts/sample-matrix.mts --json out.json   投入 script に渡す
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   これまでのサンプル検証は **人が思いついた組合せ**を 1 本ずつ書いていた。
 *   「要支援のケースを作る」「境界値 3 ケースを作る」— 見つかったバグは本物だが、
 *   ★ 「どこまで見たか」を数字で言えない。見ていない組合せが分からない。
 *
 *   因子を列挙して機械的に生成すれば、★ 網羅率が数字になる。
 *
 * ⚠ 全組合せ (直積) は 7×4×5×2×3×3×2×2×2 = 20,160 通りで現実的でない。
 *   **2 因子間の全ペアを 1 回以上通す** (pairwise) にする。
 *   相互作用のバグは大半が 2 因子の組合せで出る、という経験則に基づく。
 *   ⚠ 3 因子でしか出ないバグは ★ この方法では拾えない。そこは自覚して使う。
 *
 * ⚠ ここに並べる因子は **実装が実際に読んでいるもの**だけにする。
 *   読んでいない因子を入れても、サンプルを作った時間が無駄になる
 *   (訪問入浴の「号車」= team_id は集計が select していないので入れていない)。
 */

type Factor = { name: string; why: string; values: string[] };

/** 訪問介護 (介護保険) 明細書 7131 の出力を変える因子 */
export const FACTORS: Factor[] = [
  {
    name: "要介護度",
    why: "基本コードと区分支給限度基準額が変わる。要支援は総合事業/予防に分岐する",
    // ⚠ 2026-09-03 実測: ★ 要支援1/2 は 介護給付 (7131) の行に **一度も出ない**。
    //   総合事業 (訪問型サービス) 側に行くため。逆に 総合事業には 要介護1/2 も出る。
    //   → この行列は 制度ごとに分けて回すべき。★ 今は 介護給付 の 7131 を想定しているので
    //     要支援 を含む組合せは「有り得ない」= CONSTRAINTS に入れるのが本来。
    //   まだ入れていない: 総合事業側でこの行列を回すときに 要支援 が要るため、
    //   ★ 制度を因子に足す形で整理してから入れる (根拠なく値を消さない)。
    values: ["要支援1", "要支援2", "要介護1", "要介護2", "要介護3", "要介護4", "要介護5"],
  },
  {
    name: "サービス",
    why: "サービス項目コードが変わる。身体+生活は生活の時間で加算部分が決まる",
    values: ["身体", "生活", "身体+生活", "通院"],
  },
  {
    name: "時間帯",
    why: "早朝/夜間/深夜の加算率が変わる (深夜 50% / 夜間・早朝 25%)",
    values: ["日中", "早朝", "夜間", "深夜"],
  },
  {
    name: "所要時間",
    why: "コードの段が変わる。★ 境界値をまたぐと単位数が跳ぶ",
    values: ["20分未満", "20-30分", "30-60分", "60-90分", "90分超"],
  },
  {
    name: "2人派遣",
    why: "・2人 コードになり単位が概ね2倍。★ staff_id_2 は本番 0/22,814 件で実データに無い",
    values: ["1人", "2人"],
  },
  {
    name: "負担割合",
    why: "利用者負担額と保険請求額の割り振りが変わる (給付率 90/80/70%)",
    values: ["1割", "2割", "3割"],
  },
  {
    name: "公費",
    why: "公費請求額が立ち、利用者負担が減る。法別で本人負担の扱いが違う",
    values: ["なし", "法別12(生保)", "法別81(原爆)"],
  },
  {
    name: "限度額",
    why: "超過分は保険請求から外れて全額自費になる。★ 恒等式が壊れやすい所",
    values: ["範囲内", "ちょうど", "超過"],
  },
  {
    name: "初回加算",
    why: "限度額管理対象外の加算。★ 対象外単位数の欄に効く",
    values: ["なし", "あり"],
  },
];

/**
 * ★ 実際には有り得ない組合せ (制約)。ここに書いたペアは生成しないし、分母からも外す。
 *
 * ⚠ **今は空。**「要支援 × 訪問介護の身体90分超」のように成立しない組合せがあるはずだが、
 *   ★ 制度で裏を取れていないものをここに書くと、**検証すべき組合せを黙って除外**する。
 *   除外は「除外して良い根拠」が言えるものだけ。根拠を why に必ず書くこと。
 *
 * ⚠ 逆に、制約を書かないと ★ 有り得ないケースが FAIL して偽陽性になる。
 *   FAIL が出たら「バグ」と決める前に「そもそも成立する組合せか」を先に確かめる。
 */
export const CONSTRAINTS: { pair: [string, string, string, string]; why: string }[] = [];

const constraintKeys = new Set(
  CONSTRAINTS.flatMap(({ pair: [fa, va, fb, vb] }) => {
    const ia = FACTORS.findIndex((f) => f.name === fa);
    const ib = FACTORS.findIndex((f) => f.name === fb);
    if (ia < 0 || ib < 0) throw new Error(`制約の因子名が FACTORS にありません: ${fa} / ${fb}`);
    const [i, v, j, w] = ia < ib ? [ia, va, ib, vb] : [ib, vb, ia, va];
    return [`${i}:${v}|${j}:${w}`];
  }),
);

/** 2 因子間の全ペアを列挙 */
function allPairs(fs: Factor[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < fs.length; i++)
    for (let j = i + 1; j < fs.length; j++)
      for (const a of fs[i].values) for (const b of fs[j].values) {
        const k = `${i}:${a}|${j}:${b}`;
        if (!constraintKeys.has(k)) out.push(k);
      }
  return out;
}

/**
 * pairwise を組む。
 * ★ 「まだ覆えていないペアを 1 つ選び、その 2 因子を固定して残りを貪欲に埋める」。
 *   こうすると 1 ケースで必ず 1 組以上消えるので ★ 必ず終わる。
 *   (先に全因子を貪欲に選ぶ方式にしたら、消せるペアが 0 のケースを作って止まった)
 */
function buildPairwise(fs: Factor[]): string[][] {
  const need = new Set(allPairs(fs));
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

const cases = buildPairwise(FACTORS);
const total = allPairs(FACTORS).length;
const product = FACTORS.reduce((a, f) => a * f.values.length, 1);

// ── 自己検査: 生成したケース集合が本当に全ペアを覆っているか ──
{
  const seen = new Set<string>();
  for (const c of cases)
    for (let i = 0; i < c.length; i++)
      for (let j = i + 1; j < c.length; j++) seen.add(`${i}:${c[i]}|${j}:${c[j]}`);
  const missing = allPairs(FACTORS).filter((p) => !seen.has(p));
  if (missing.length) {
    console.error(`★ FAIL 覆えていないペアが ${missing.length} 件: ${missing.slice(0, 5).join(" / ")}`);
    process.exit(1);
  }
  // ★ 負のコントロール: 1 ケース抜いたら必ず穴が開くこと
  //   (抜いても覆えているなら、そのケースは無駄 = 生成器のバグ)
  const dropped = cases.slice(0, -1);
  const seen2 = new Set<string>();
  for (const c of dropped)
    for (let i = 0; i < c.length; i++)
      for (let j = i + 1; j < c.length; j++) seen2.add(`${i}:${c[i]}|${j}:${c[j]}`);
  if (allPairs(FACTORS).every((p) => seen2.has(p))) {
    console.error("★ FAIL 最後のケースを抜いても全ペアを覆えている = 冗長なケースを出している");
    process.exit(1);
  }
}

console.log(`因子 ${FACTORS.length} 個 / 全組合せ (直積) ${product.toLocaleString()} 通り`);
console.log(`2因子間のペア ${total.toLocaleString()} 組 → ★ ${cases.length} ケースで全部通る`);
console.log(`  (直積の ${((cases.length / product) * 100).toFixed(2)}% のケース数で 2因子間は 100%)`);
console.log("");
console.log(`制約 (有り得ない組合せ) ${CONSTRAINTS.length} 件 ★ 未検証 — 空のままだと成立しない組合せも生成されます`);
console.log("⚠ 3 因子でしか出ないバグはこの方法では拾えません。");
console.log("");

if (process.argv.includes("--json")) {
  const out = process.argv[process.argv.indexOf("--json") + 1];
  const rows = cases.map((c, i) => Object.fromEntries([["case", `M${String(i + 1).padStart(3, "0")}`], ...c.map((v, k) => [FACTORS[k].name, v] as const)]));
  require("node:fs").writeFileSync(out, JSON.stringify(rows, null, 2) + "\n", "utf8");
  console.log(`→ ${out} に ${rows.length} ケースを書きました`);
} else {
  const w = FACTORS.map((f) => Math.max(f.name.length, ...f.values.map((v) => v.length)));
  console.log("     " + FACTORS.map((f, i) => f.name.padEnd(w[i])).join(" "));
  cases.forEach((c, i) => console.log(`M${String(i + 1).padStart(3, "0")} ` + c.map((v, k) => v.padEnd(w[k])).join(" ")));
}
