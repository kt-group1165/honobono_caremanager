/**
 * 訪問入浴 記録作成時のコード解決 (src/lib/bath-seikyu/resolve-code.ts) の検証
 * (DB不使用・純関数のみ。B-1w対応)
 *
 *   npx tsx scripts/bath-resolve-code-verify.mts
 */
import { resolveBathCode } from "../src/lib/bath-seikyu/resolve-code";

let n = 0, ng = 0;
function eq(label: string, actual: unknown, expected: unknown) {
  n++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) ng++;
  console.log(`  ${ok ? "OK " : "NG "} ${label.padEnd(60)} ${ok ? "" : `実際=${JSON.stringify(actual)} 期待=${JSON.stringify(expected)}`}`);
}

console.log("═══ 要介護 (種類12) — 従来通り ═══");
eq("要介護1 全身浴 看護あり → 121111", resolveBathCode("全身浴", false, "要介護1"), "121111");
eq("要介護3 全身浴 職員のみ → 121121", resolveBathCode("全身浴", true, "要介護3"), "121121");
eq("要介護5 部分浴 看護あり → 121112", resolveBathCode("部分浴", false, "要介護5"), "121112");
eq("要介護2 部分浴 職員のみ → 121122", resolveBathCode("部分浴", true, "要介護2"), "121122");
eq("未設定(null) 全身浴 看護あり → 121111 (介護を既定にする)", resolveBathCode("全身浴", false, null), "121111");
eq("未設定(undefined) → 121111", resolveBathCode("全身浴", false, undefined), "121111");

console.log("\n═══ ★ 予防給付 (種類62) — B-1w修正後 ═══");
eq("★ 要支援1 全身浴 看護あり → 621111 (旧: 121111だった)", resolveBathCode("全身浴", false, "要支援1"), "621111");
eq("★ 要支援2 全身浴 看護あり → 621111", resolveBathCode("全身浴", false, "要支援2"), "621111");
eq("★ 事業対象者 全身浴 看護あり → 621111", resolveBathCode("全身浴", false, "事業対象者"), "621111");
eq("要支援1 全身浴 職員のみ → 621121", resolveBathCode("全身浴", true, "要支援1"), "621121");
eq("要支援2 部分浴 看護あり → 621112", resolveBathCode("部分浴", false, "要支援2"), "621112");
eq("要支援1 部分浴 職員のみ → 621122", resolveBathCode("部分浴", true, "要支援1"), "621122");

console.log("\n═══ 負のコントロール ═══");
{
  // ① 修正前の実装(要介護度を見ない)を再現し、要支援に対して121111を返すことを確認
  //    → 現実装との差分で、この検査が実際にB-1wを検出できることを示す
  const oldImpl = (bathType: "全身浴" | "部分浴", staffOnly: boolean): string => {
    if (bathType === "全身浴") return staffOnly ? "121121" : "121111";
    return staffOnly ? "121122" : "121112";
  };
  const real = resolveBathCode("全身浴", false, "要支援2");
  const broken = oldImpl("全身浴", false);
  n++;
  if (real !== broken) {
    console.log(`  OK  負のコントロール — 現実装(${real})と旧実装(${broken})が別の値を返す (このテストがB-1wを検出できることの確認)`);
  } else {
    ng++;
    console.log(`  NG  負のコントロール失敗 — 修正前後で結果が変わらない`);
  }
}
{
  // ② isYoboLevelを直接壊さず、この関数だけ「要支援を見誤る」バグを作って検出できるか
  const brokenResolve = (bathType: "全身浴" | "部分浴", staffOnly: boolean, careLevel: string | null | undefined): string => {
    // わざと「事業対象者」を判定漏れさせる
    const isYobo = careLevel === "要支援1" || careLevel === "要支援2";
    if (isYobo) return bathType === "全身浴" ? (staffOnly ? "621121" : "621111") : (staffOnly ? "621122" : "621112");
    return bathType === "全身浴" ? (staffOnly ? "121121" : "121111") : (staffOnly ? "121122" : "121112");
  };
  const real = resolveBathCode("全身浴", false, "事業対象者");
  const broken = brokenResolve("全身浴", false, "事業対象者");
  n++;
  if (real !== broken) {
    console.log(`  OK  負のコントロール② — 事業対象者の判定漏れ版(${broken})と現実装(${real})が別の値 (事業対象者ケースも検出できる)`);
  } else {
    ng++;
    console.log(`  NG  負のコントロール②失敗`);
  }
}

console.log(`\n══ 検査 ${n} 件 / NG ${ng} 件 ══`);
if (ng > 0) process.exitCode = 1;
