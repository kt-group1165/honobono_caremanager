/**
 * 処遇改善等 (%加算) の計算式 — 4 制度の独立実装を ★ そのままの式で写して突き合わせる
 * (DB 不使用。統合はしない。まず一致するかどうかだけ出す — H の指示)
 *
 *   npx tsx scripts/shoguu-kaizen-4impl-diff.mts
 *
 * ── 背景 ─────────────────────────────────────────────────────────────
 *   service-code-calc-verify.mts (2026-09-05) で判明: 処遇改善等の %計算は
 *   ★ 共通モジュール (calculateUnits) を通らず、制度ごとに 4 箇所へ別々に
 *   再実装されている。同じ日に 2 件、この型の実装乖離が実際に見つかっている
 *   (出勤簿計算の法定休日判定 / 福祉用具の半月按分 floor-ceil vs round)。
 *   ★ 利用者請求書は 3 実装が偶然一致していた (riyou-seikyu-final-amount-diff.mts)。
 *   一致するかどうかは確かめるまで分からない、という前例に倣う。
 *
 * ── 対象 4 実装 (すべて ★ 逐語で写した。要約しない。行番号を併記) ──────────
 *   A. claims-shared.ts calcTotals() (:471-483)          — 居宅介護支援
 *   B. visit-seikyu/aggregate.ts (:1756)                  — 訪問介護 (介護保険)
 *   C. visit-seikyu/aggregate-sougou.ts (:801)            — 総合事業
 *   D. shogai-seikyu/aggregate.ts (:1081-1083)            — 障害
 *
 * ⚠ 4 実装は「addon 計算式そのもの」だけを比較対象にする。各制度の「何を base に
 *   含めるか」(超過分の扱い・A3除外・初回加算の合算 等) は制度ごとに正当に異なるため、
 *   ★ base と numerator/denominator を揃えた上で、そこから先の 1 行だけを比較する。
 *   (これは L の riyou-seikyu-final-amount-diff.mts と同じ切り分け方: 「合成のしかた」
 *   ではなく「その関数が実際にやっている計算」を写して比べる)
 */

// ---------------------------------------------------------------- A. 居宅介護支援
/** calcTotals (claims-shared.ts:471-483) を addon 部分だけ逐語で写す。
 *  ⚠ A だけ denominator が引数に無く ★ 1000 固定 (shoguuPermil = ‰)。
 *    他3実装は numerator/denominator を直接受け取る。実データは全件 denominator=1000
 *    なので現状は等価だが、★ 構造としては A だけ「呼出側が事前に ‰ へ変換している」
 *    前提になっている。 */
function addon_A_kyotaku(subtotal: number, shoguuPermil: number): number {
  return shoguuPermil > 0 ? Math.round((subtotal * shoguuPermil) / 1000) : 0;
}

// ---------------------------------------------------------------- B. 訪問介護
/** visit-seikyu/aggregate.ts:1756 を逐語で写す */
function addon_B_houmon(baseUnits: number, addonNum: number, addonDen: number): number {
  return addonNum > 0 ? Math.round((baseUnits * addonNum) / addonDen) : 0;
}

// ---------------------------------------------------------------- C. 総合事業
/** visit-seikyu/aggregate-sougou.ts:801 を逐語で写す (addonBaseUnits は呼出側で
 *  A3除外済みの値を渡す想定。この関数自体は B と同じ式) */
function addon_C_sougou(addonBaseUnits: number, addonNum: number, addonDen: number): number {
  return addonNum > 0 ? Math.round((addonBaseUnits * addonNum) / addonDen) : 0;
}

// ---------------------------------------------------------------- D. 障害
/** shogai-seikyu/aggregate.ts:1078-1085 を逐語で写す。
 *  ⚠ D だけ ★ ガードの位置が違う: 他3実装は「率>0」を先に見るが、
 *    D は「率オブジェクトの有無 (!rate) と units<=0」を先に見て、
 *    計算した後に「結果 au>0」で弾く (au<=0 なら addons に積まない)。
 *    ★ ガードの対象が「入力(率)」か「出力(計算結果)」かが違う。
 *    率がぴったり0のときの最終結果は同じ (0)。率が★負の場合だけ挙動が変わりうる
 *    (実データに負のnumeratorは無いことを service-code-calc-verify.mts で確認済み)。 */
function addon_D_shogai(units: number, rateNum: number, rateDen: number): number {
  if (units <= 0) return 0; // !rate 相当 (このharnessでは呼ばれた時点でrateは常に有り)
  const au = Math.round((units * rateNum) / rateDen);
  return au > 0 ? au : 0; // ★「au>0」が真の実装のガード。au<0 (率が負) だと 0 に丸められてしまう
}

// ---------------------------------------------------------------- 突き合わせ
type Case = {
  name: string;
  base: number;
  num: number;
  den: number;
};

const CASES: Case[] = [
  { name: "今日の実測: 障害 同行援護区分3 (441/1000)", base: 229, num: 441, den: 1000 },
  { name: "今日の実測: 居宅 処遇改善 (21/1000)", base: 1086, num: 21, den: 1000 },
  { name: "★ numerator=0 (実在6件)", base: 1000, num: 0, den: 1000 },
  { name: "★ 端数 0.5 ちょうど (100×5/1000=0.5)", base: 100, num: 5, den: 1000 },
  { name: "★ 端数 0.49999… に近い (999×5/10000)", base: 999, num: 5, den: 10000 },
  { name: "base=0 (退所月・実績0)", base: 0, num: 441, den: 1000 },
  { name: "★ 高率 (100% = 1000/1000)", base: 733, num: 1000, den: 1000 },
  { name: "実データ最大クラスの率 (446/1000)", base: 4177, num: 446, den: 1000 },
  { name: "1単位ちょうどに丸まる小さいbase (rate小)", base: 3, num: 96, den: 1000 },
  { name: "★ 奇数base×奇数rate (丸め境界を突く)", base: 12345, num: 273, den: 1000 },
];

let mismatches = 0;
console.log("=== 4 実装の突き合わせ (A=居宅 / B=訪問介護 / C=総合事業 / D=障害) ===\n");
for (const c of CASES) {
  const a = addon_A_kyotaku(c.base, c.num); // A は denominator 固定1000なので den!=1000 のケースはA非対応 (下で別途明示)
  const b = addon_B_houmon(c.base, c.num, c.den);
  const cc = addon_C_sougou(c.base, c.num, c.den);
  const d = addon_D_shogai(c.base, c.num, c.den);

  if (c.den === 1000) {
    const ok = a === b && b === cc && cc === d;
    if (!ok) mismatches += 1;
    console.log(`  ${ok ? "✓" : "✗"} ${c.name}`);
    console.log(`      A(居宅)=${a}  B(訪問介護)=${b}  C(総合事業)=${cc}  D(障害)=${d}`);
  } else {
    // ★ A は denominator を引数に取らない (1000固定) ので denominator!=1000 のケースには
    //   そのままでは対応できない。呼出側が num を「1000分率に変換してから」渡す前提。
    //   B/C/D の3実装だけで比較する。
    const ok = b === cc && cc === d;
    if (!ok) mismatches += 1;
    console.log(`  ${ok ? "✓" : "✗"} ${c.name}  ★ denominator≠1000 (A は構造上比較対象外)`);
    console.log(`      B(訪問介護)=${b}  C(総合事業)=${cc}  D(障害)=${d}`);
    // 参考: A に num/den を先に1000分率へ換算して渡したら一致するか (呼出側がやるべき変換)
    const aConverted = addon_A_kyotaku(c.base, Math.round((c.num / c.den) * 1000));
    console.log(`      (参考) A に num/den→‰換算して渡すと=${aConverted}  ${aConverted === b ? "(変換すれば一致)" : "★(変換しても不一致)"}`);
  }
}

console.log("\n=== ★ 構造上の差異 (計算結果ではなく実装のガード条件) ===");
console.log("  A: shoguuPermil > 0 で判定 (率そのもの)");
console.log("  B/C: addonNum > 0 で判定 (率そのもの)");
console.log("  D: units <= 0 → 0 (先) / 計算後 au > 0 で判定 (★ 後)");
console.log("  → 率が負の値を取ることは実データに無い (service-code-calc-verify.mts で確認済み)。");
{
  const negNum = -100;
  const a = addon_A_kyotaku(1000, negNum);
  const b = addon_B_houmon(1000, negNum, 1000);
  const cc = addon_C_sougou(1000, negNum, 1000);
  const d = addon_D_shogai(1000, negNum, 1000);
  const allZero = a === 0 && b === 0 && cc === 0 && d === 0;
  console.log(`  仮に率が負だったら (実データには無い想定シナリオ): A=${a} B=${b} C=${cc} D=${d}`);
  console.log(`  ${allZero ? "OK" : "★"}  ★ 当初「A/B/Cは負の加算をそのまま返す」と予想したが誤りだった (規律3-2)。`);
  console.log(`     ★ 実際は4実装とも「率>0」を入口 (A/B/C) か出口 (D) のどちらかで見ており、`);
  console.log(`     負の率は4実装とも一律0になる。ガードの★位置は違うが★結果は一致 (差異は実害なし)。`);
}

// ---------------------------------------------------------------- ★ 負のコントロール
console.log("\n=== 負のコントロール (harness がズレを検出できるか) ===");
let negOk = 0;
{
  // ① B の rounding を floor に変えてしまうバグを模擬 (今日の福祉用具事故と同じ型)。
  //   ★ 端数が.5以上のケースでないと round と floor が偶然一致してしまう
  //   (12345×273/1000=3370.185 のような .5未満の端数では検出できなかった —
  //    実際にこの harness を書く途中で踏んだ)。端数.5ちょうどのケースを使う。
  const base = 100, num = 5, den = 1000; // 100×5/1000 = 0.5 ちょうど
  const correctB = addon_B_houmon(base, num, den);
  const brokenB = Math.floor((base * num) / den); // わざと floor
  const detected1 = correctB !== brokenB;
  console.log(`  ${detected1 ? "✓" : "✗"} ① round→floor のすり替えを検出できる (正=${correctB} / floor=${brokenB})`);
  if (detected1) negOk += 1;
}
{
  // ② D の base を間違えて2倍にしてしまうバグを模擬
  const units = 229, num = 441, den = 1000;
  const correctD = addon_D_shogai(units, num, den);
  const brokenD = addon_D_shogai(units * 2, num, den);
  const detected2 = correctD !== brokenD;
  console.log(`  ${detected2 ? "✓" : "✗"} ② base の取り違え (2倍) を検出できる (正=${correctD} / 2倍base=${brokenD})`);
  if (detected2) negOk += 1;
}
if (negOk < 2) {
  console.error("\n✗ 負のコントロールが機能していない。harness 自体を疑うこと");
  process.exit(1);
}

console.log(`\n${mismatches === 0 ? "✅ PASS — addon計算式そのものは denominator=1000 のケースで4実装とも一致 (負のコントロール2/2 OK)" : `❌ FAIL — ${mismatches} 件不一致。差の中身は上の表を参照 (統合しない・どちらが正かは決めない)`}`);
process.exit(mismatches === 0 ? 0 : 1);
