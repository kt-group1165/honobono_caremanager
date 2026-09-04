/**
 * 移動支援・訪問入浴の ★ 金額計算 の検証 (DB 不使用・純関数)
 *
 *   npx tsx scripts/idou-summary-verify.mts
 *
 * ⚠ この計算は 2026-09-04 まで ★ client component の中にあり、
 *   ハーネスから呼べないので一度も検証されていなかった。
 *   期待値は ★ 実装の出力ではなく、規則から手で出している。
 *
 *   規則 (画面のコメントと 2026-08-31 の監査に基づく):
 *     利用者負担 = 生保 → 0
 *                それ以外 → min(floor(総費用 × 10%), 負担上限月額)
 *     ★ 上限 null = 未設定 (判定不能) → 金額は推測せず 0。警告で気づかせる
 *     ★ 上限 0   = 非課税で本当に 0 円 (未設定とは別)
 *     市への請求 = 総費用 − 利用者負担
 */
import {
  UNIT_YEN,
  clientBurdenOf,
  isBurdenUndeterminable,
  summarizeIdouBilling,
  type BurdenCert,
} from "@/lib/idou-billing-summary";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

const cert = (limit: number | null, seiho = false): BurdenCert => ({ limit, seiho });

// ── 負担額の境界 ────────────────────────────────────────────────────────
// 上限 4,600 円。10% がちょうど上限に乗る / 下回る / 超える の 3 点
eq("1割が上限より小さい (3,000円 → 300)", clientBurdenOf(cert(4600), 3000), 300);
eq("★ 1割がちょうど上限 (46,000円 → 4,600)", clientBurdenOf(cert(4600), 46000), 4600);
eq("★ 1割が上限を超える (50,000円 → 上限 4,600)", clientBurdenOf(cert(4600), 50000), 4600);
eq("★ 端数は切り捨て (3,009円 → 300 であって 301 ではない)", clientBurdenOf(cert(4600), 3009), 300);
eq("★ 上限 0 (非課税) は 0 円", clientBurdenOf(cert(0), 50000), 0);
eq("生保は 0 円", clientBurdenOf(cert(4600, true), 50000), 0);
eq("★ 上限 未設定 は 推測せず 0", clientBurdenOf(cert(null), 50000), 0);
eq("★ 受給者証なし は 推測せず 0", clientBurdenOf(undefined, 50000), 0);

// ── 判定不能かどうか ────────────────────────────────────────────────────
eq("★ 受給者証なし = 判定不能", isBurdenUndeterminable(undefined), true);
eq("★ 上限 未設定 = 判定不能", isBurdenUndeterminable(cert(null)), true);
eq("★ 上限 0 は 判定不能ではない (非課税で確定)", isBurdenUndeterminable(cert(0)), false);
eq("生保は 判定不能ではない", isBurdenUndeterminable(cert(null, true)), false);
eq("上限あり は 判定不能ではない", isBurdenUndeterminable(cert(4600)), false);

// ── 事業所サマリ ────────────────────────────────────────────────────────
// ★ 上限は 利用者ごとに当たる。事業所の総費用に一括で 10% を掛けてはいけない
{
  const units = new Map([["a", 5000], ["b", 300]]); // 50,000円 / 3,000円
  const certs = new Map([["a", cert(4600)], ["b", cert(4600)]]);
  const s = summarizeIdouBilling(units, certs);
  eq("サマリ 総単位", s.totalUnits, 5300);
  eq("サマリ 総費用", s.totalCost, 53000);
  // a: min(5000, 4600) = 4600 / b: min(300, 4600) = 300
  eq("★ サマリ 負担 (利用者ごとに上限)", s.burden, 4900);
  // ⚠ 一括で 10% を掛けると 5,300 になる = ★ 400 円 過大
  eq("★ 一括10%との差 (過大になる額)", Math.floor(s.totalCost * 0.1) - s.burden, 400);
  eq("サマリ 市請求", s.cityClaim, 48100);
  eq("サマリ 人数", s.count, 2);
}
{
  // 判定不能が混ざると 負担 0 のまま = ★ 市へ全額請求になる。警告が要る側
  const units = new Map([["a", 5000], ["x", 5000]]);
  const certs = new Map([["a", cert(4600)]]); // x は受給者証なし
  const s = summarizeIdouBilling(units, certs);
  eq("★ 判定不能が混ざると 負担はその人ぶんだけ", s.burden, 4600);
  eq("★ そのぶん 市請求が増える", s.cityClaim, 100000 - 4600);
}
eq("単価は 10 円固定", UNIT_YEN, 10);

// ── 負のコントロール (3-9) ──────────────────────────────────────────────
// わざと壊した実装で、同じ検査が鳴ることを確かめる
{
  const brokenMin = (c: BurdenCert | undefined, cost: number) =>
    !c || c.seiho || c.limit == null ? 0 : Math.floor(cost * 0.1); // ★ 上限を当てない
  const brokenRound = (c: BurdenCert | undefined, cost: number) =>
    !c || c.seiho || c.limit == null ? 0 : Math.min(Math.round(cost * 0.1), c.limit); // ★ 四捨五入
  const checks: [string, boolean][] = [
    ["上限を当てない実装", brokenMin(cert(4600), 50000) !== 4600],
    ["★ 端数を四捨五入する実装", brokenRound(cert(4600), 3005) !== clientBurdenOf(cert(4600), 3005)],
  ];
  for (const [label, fired] of checks) {
    if (fired) pass++;
    else fails.push(`★ 負のコントロールが鳴らない: ${label} — 検査が効いていません`);
  }
}

console.log(`移動支援・訪問入浴 金額計算の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exit(1);
}
