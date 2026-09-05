/**
 * 利用者請求書 (介護・総合事業) の ★ 最終額計算 の検証 (DB 不使用・純関数)
 *
 *   npx tsx scripts/riyou-seikyu-final-amount-verify.mts
 *
 * ⚠ この計算は 2026-09-04 まで riyou-seikyu-content.tsx (client component) の
 *   useCallback の中にあり、ハーネスから呼べなかった。同じ式が印刷用の
 *   別コンポーネント2つ (RiyouSeikyuPrintSheet / RiyouSeikyuHouseholdPrintSheet)
 *   に inline で再実装されていたため、統合前に境界値12ケースで一致を確認済み
 *   (scripts/riyou-seikyu-final-amount-diff.mts)。★ この検証はその後、
 *   3実装が 1 つの src/lib/riyou-seikyu-final-amount.ts に統合された後の
 *   単体テスト。今後この関数を変更したら、まずここを通すこと。
 *
 *   規則 (画面のコメント通り):
 *     軽減額     = 対象月に有効なら round(負担額 × 軽減率 / 100)、無効なら 0
 *     当月請求額 = (法定負担 + 超過自費) − 軽減額 + 実費
 *     繰越額     = 前月請求 − 前月入金 (前月レコード無しは 0)
 *     今回御請求額 = 当月請求額 + 繰越額
 *     医療費控除対象額 = round(軽減後負担額 × 対象単位比率) (対象月に有効な軽減済み負担額を使う)
 *
 * ⚠ 2026-09-05 追加: computeIryohiAmount (医療費控除)。kaigo_riyou_settings が
 *   実データ0件のため未使用の機能だが、金額計算なので境界値を先に固定する。
 */
import {
  keigenActiveInMonth,
  computeKeigenAmount,
  computeMonthTotal,
  computeCarry,
  computeGrandTotal,
  computeIryohiAmount,
  type KeigenSetting,
} from "@/lib/riyou-seikyu-final-amount";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

const setting = (rate: number | null, start: string | null = null, end: string | null = null): KeigenSetting => ({
  keigen_rate: rate,
  keigen_start_date: start,
  keigen_end_date: end,
});

// ── keigenActiveInMonth の境界 ──────────────────────────────────────────
eq("設定なし (undefined) は 無効", keigenActiveInMonth(undefined, "2026-06"), false);
eq("keigen_rate が null は 無効", keigenActiveInMonth(setting(null), "2026-06"), false);
eq("keigen_rate が 0 は 無効", keigenActiveInMonth(setting(0), "2026-06"), false);
eq("keigen_rate が 負 は 無効", keigenActiveInMonth(setting(-5), "2026-06"), false);
eq("開始/終了なし・rate>0 は 有効", keigenActiveInMonth(setting(10), "2026-06"), true);
eq("★ 開始が対象月より後 は 無効", keigenActiveInMonth(setting(10, "2026-07-01"), "2026-06"), false);
eq("★ 開始が対象月ちょうど は 有効", keigenActiveInMonth(setting(10, "2026-06-01"), "2026-06"), true);
eq("★ 終了が対象月より前 は 無効", keigenActiveInMonth(setting(10, null, "2026-05-31"), "2026-06"), false);
eq("★ 終了が対象月ちょうど は 有効", keigenActiveInMonth(setting(10, null, "2026-06-01"), "2026-06"), true);
eq("開始<=月内<=終了 は 有効", keigenActiveInMonth(setting(10, "2026-01-01", "2026-12-31"), "2026-06"), true);

// ── computeKeigenAmount の境界 ──────────────────────────────────────────
eq("無効なら 0", computeKeigenAmount(20155, 50, false), 0);
eq("10% は round される", computeKeigenAmount(20155, 10, true), 2016); // 2015.5 → 2016
eq("★ 端数 .5 は四捨五入 (Math.round)", computeKeigenAmount(20155, 10, true), Math.round(2015.5));
eq("rate=null は 0 円控除 (無効と同じ)", computeKeigenAmount(20155, null, true), 0);
eq("userAmount=0 は 0", computeKeigenAmount(0, 50, true), 0);

// ── computeMonthTotal / computeCarry / computeGrandTotal ────────────────
eq("軽減なし・実費なし", computeMonthTotal(20000, 0, 0), 20000);
eq("軽減あり", computeMonthTotal(20000, 2000, 0), 18000);
eq("実費あり", computeMonthTotal(20000, 0, 1500), 21500);
eq("軽減+実費 複合", computeMonthTotal(20000, 2000, 1500), 19500);

eq("繰越: 前月レコード無し (null,null) は 0", computeCarry(null, null), 0);
eq("繰越: 片方だけ null でも 0 扱い", computeCarry(8000, null), 0);
eq("★ 繰越 正 (未収繰越)", computeCarry(8000, 3000), 5000);
eq("★ 繰越 負 (過入金充当)", computeCarry(3000, 8000), -5000);
eq("繰越 0 (ちょうど完済)", computeCarry(5000, 5000), 0);

eq("今回御請求額 = 当月請求額 + 繰越 (繰越正)", computeGrandTotal(15000, 5000), 20000);
eq("今回御請求額 = 当月請求額 + 繰越 (繰越負)", computeGrandTotal(15000, -5000), 10000);
eq("繰越0なら 当月請求額のまま", computeGrandTotal(15000, 0), 15000);

// ── computeIryohiAmount (医療費控除対象額) の境界 ────────────────────────
eq("対象者でない (iryohiTaisho=false) は 0", computeIryohiAmount(false, 1000, 1000, 20000), 0);
eq("totalUnits=0 (実績なし) は 0", computeIryohiAmount(true, 0, 0, 20000), 0);
eq("totalUnits が負 (異常値) も 0 扱い", computeIryohiAmount(true, -1, 0, 20000), 0);
eq("生活援助のみ (eligibleUnits=0) は 0", computeIryohiAmount(true, 1000, 0, 20000), 0);
eq("生活援助なし (eligibleUnits=totalUnits) は afterKeigen そのまま", computeIryohiAmount(true, 1000, 1000, 20000), 20000);
eq("★ 一部が対象 (半分) は 半分の額", computeIryohiAmount(true, 1000, 500, 20000), 10000);
eq("★ 端数は四捨五入 (割り切れない比率)", computeIryohiAmount(true, 3, 1, 10000), Math.round((10000 * 1) / 3));
eq("afterKeigen=0 (軽減で全額相殺) は 0", computeIryohiAmount(true, 1000, 500, 0), 0);

// ── 負のコントロール: 丸め順序 (先に比率を float 化すると端数がズレる) ──────
{
  // コードのコメント「整数演算 (比率を先に float 化しない)」を裏取りする。
  // 3等分など割り切れない比率で、演算順序を変えると結果がズレるケースを探す。
  const afterKeigen = 10000, total = 3, eligible = 1;
  const correct = computeIryohiAmount(true, total, eligible, afterKeigen); // round(10000*1/3)
  const ratioFirst = Math.round(afterKeigen * Math.round((eligible / total) * 100) / 100); // 比率を先に丸めてから掛ける (壊れた実装の一例)
  const detected = correct !== ratioFirst;
  if (detected) pass++;
  else fails.push(`★ 負のコントロールが鳴らない: 丸め順序の違いを検出できない (correct=${correct} / ratioFirst=${ratioFirst})`);
  console.log(`  ${detected ? "✓" : "✗"} ★ 丸め順序を変えると結果がズレることを検出 (正=${correct} / 比率先丸め=${ratioFirst})`);
}

// ── 複合 (奇数額・丸め境界) ───────────────────────────────────────────────
{
  const userPlusSelf = 20001 + 999; // 21000
  const keigen = computeKeigenAmount(userPlusSelf, 15, true); // round(21000*0.15)=3150
  const jippiSum = 1501 + 2499; // 4000
  const monthTotal = computeMonthTotal(userPlusSelf, keigen, jippiSum);
  const carry = computeCarry(12345, 6789);
  const grandTotal = computeGrandTotal(monthTotal, carry);
  eq("複合 keigen", keigen, 3150);
  eq("複合 monthTotal", monthTotal, 21000 - 3150 + 4000);
  eq("複合 carry", carry, 5556);
  eq("複合 grandTotal", grandTotal, 21850 + 5556);
}

// ── 負のコントロール (3-9) ──────────────────────────────────────────────
// わざと壊した実装で、同じ検査が鳴ることを確かめる
{
  const brokenKeigenDouble = (userAmount: number, rate: number | null, active: boolean) =>
    computeKeigenAmount(userAmount, rate, active) * 2; // ★ 軽減を2重に控除
  // ★ null を ?? 0 で握りつぶす素朴な実装 (前月レコード「片方だけ無い」を誤って計上する)
  const brokenCarryTreatsNullAsZero = (billed: number | null, paid: number | null) =>
    (billed ?? 0) - (paid ?? 0);
  const checks: [string, boolean][] = [
    [
      "★ 軽減2重控除を検出できる",
      computeMonthTotal(20000, brokenKeigenDouble(20000, 10, true), 0) !==
        computeMonthTotal(20000, computeKeigenAmount(20000, 10, true), 0),
    ],
    [
      "★ 繰越の null 未対応 (片方だけ無いレコード) を検出できる",
      // billed=8000 だけあって paid が無い (取込漏れ等) → 正は「前月レコード不完全 = 0」
      // だが壊れた実装は 8000 - 0 = 8000 を返し、未収繰越が勝手に発生する
      brokenCarryTreatsNullAsZero(8000, null) !== computeCarry(8000, null),
    ],
  ];
  for (const [label, fired] of checks) {
    if (fired) pass++;
    else fails.push(`★ 負のコントロールが鳴らない: ${label} — 検査が効いていません`);
  }
}

console.log(`利用者請求書 最終額計算の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exit(1);
}
