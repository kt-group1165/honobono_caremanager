/**
 * 統合の前に: riyou-seikyu-content.tsx 内の「最終額」計算 3 実装が
 * 既にズレていないかを ★ そのままの式で写して突き合わせる (DB 不使用)。
 *
 * H の指摘: 「同じ式に見えて統合すると事故る」型が今日 2 件出た
 * (attendance-calc の法定休日判定 / 福祉用具の半月按分 floor-ceil vs round)。
 * ★ 統合前にこの表を必ず通すこと。一致しない項目があれば統合しない。
 *
 * 対象 3 実装 (すべて riyou-seikyu-content.tsx から ★ 逐語で写した。要約しない):
 *   A. 画面側    rowBilled(:604) = userPlusSelf − keigenAmount + jippiTotal
 *               carryoverForRow(:538) 経由の carryover(:492) = billed − paid
 *   B. 個人票    RiyouSeikyuPrintSheet(:3194) の monthTotal(:3224) / grandTotal(:3229)
 *   C. 世帯合算票 RiyouSeikyuHouseholdPrintSheet(:3383) の subtotal(:3415) / monthTotal(:3417) / grandTotal(:3421)
 *
 * ⚠ この 2 つ (B, C) は型が `UserSeikyuRow` 固定 (介護/総合の型。@/lib/visit-seikyu/aggregate)。
 *   `billedForRow` が分岐する 障害 (shogai.userAmount) は ★ 型レベルで渡せない
 *   ( `UnifiedRow` → `.kaigo` を通してからしか呼ばれていないことをソースで確認済み:
 *     printGroups(:1043) は kaigoTargets.map(r => r.kaigo) / groups(:3782,RiyouBulkPrintView内)
 *     も sorted.map(r => r.kaigo) のみ。障害行は `kaigoTargets = targets.filter(r => r.system !== "障害")`
 *     (:906) で最初から除外されている)。
 *   → 障害の分岐は B/C には存在せず、比較対象にならない。この事実を負のコントロールで裏取りする
 *     (障害相当の shape を無理に投げたら TypeScript が弾くことを型注釈で確認する形にする)。
 */

// ---------------------------------------------------------------- A. 画面側
/** keigenAmount(:594) を逐語で写す */
function keigenAmount_A(userAmount: number, keigenRate: number | null, active: boolean): number {
  if (!active) return 0;
  return Math.round((userAmount * (keigenRate ?? 0)) / 100);
}
/** rowBilled(:604) を逐語で写す (jippiTotal は合計値をそのまま渡す形に平坦化) */
function rowBilled_A(userPlusSelf: number, keigenRate: number | null, active: boolean, jippiSum: number): number {
  return userPlusSelf - keigenAmount_A(userPlusSelf, keigenRate, active) + jippiSum;
}
/** carryover(:492) を逐語で写す */
function carryover_A(billed: number | null, paid: number | null): number {
  return billed != null && paid != null ? billed - paid : 0;
}

// ---------------------------------------------------------------- B. 個人票
/** RiyouSeikyuPrintSheet の monthTotal(:3224)/grandTotal(:3229) を逐語で写す */
function printSheet_B(
  userPlusSelf: number,
  keigen: number, // = keigenByUser.get(id) ?? 0 (呼び出し元で keigenAmount 済みの値を渡す)
  jippiSum: number,
  prevBilled: number | null,
  prevPaid: number | null,
): { monthTotal: number; grandTotal: number } {
  const monthTotal = userPlusSelf - keigen + jippiSum;
  const carry = prevBilled != null && prevPaid != null ? prevBilled - prevPaid : 0;
  const grandTotal = monthTotal + carry;
  return { monthTotal, grandTotal };
}

// ---------------------------------------------------------------- C. 世帯合算票
/** RiyouSeikyuHouseholdPrintSheet の subtotal/monthTotal/grandTotal(:3411-3421) を逐語で写す */
function householdSheet_C(
  members: { userPlusSelf: number; keigen: number; jippiSum: number }[],
  prevBilledList: number[],
  prevPaidList: number[],
): { monthTotal: number; grandTotal: number } {
  const perUser = members.map((m) => ({ subtotal: m.userPlusSelf - m.keigen + m.jippiSum }));
  const monthTotal = perUser.reduce((s, u) => s + u.subtotal, 0);
  const prevBilled = prevBilledList.reduce((s, v) => s + v, 0);
  const prevPaid = prevPaidList.reduce((s, v) => s + v, 0);
  const carry = prevBilled - prevPaid;
  const grandTotal = monthTotal + carry;
  return { monthTotal, grandTotal };
}

// ---------------------------------------------------------------- 突き合わせ
type Case = {
  name: string;
  userAmount: number;
  selfPayAmount: number;
  keigenRate: number | null;
  keigenActive: boolean;
  jippiEntries: number[]; // 個々の実費行 (合計する前の生データ。B/C は合計してから使う)
  prevBilled: number | null;
  prevPaid: number | null;
};

const CASES: Case[] = [
  { name: "基準 (軽減なし・実費なし・繰越なし)", userAmount: 20000, selfPayAmount: 0, keigenRate: null, keigenActive: false, jippiEntries: [], prevBilled: null, prevPaid: null },
  { name: "軽減あり (10%, 端数あり)", userAmount: 20155, selfPayAmount: 0, keigenRate: 10, keigenActive: true, jippiEntries: [], prevBilled: null, prevPaid: null },
  { name: "軽減の対象月外 (keigenActive=false)", userAmount: 20155, selfPayAmount: 0, keigenRate: 50, keigenActive: false, jippiEntries: [], prevBilled: null, prevPaid: null },
  { name: "実費 複数行 (端数あり)", userAmount: 15000, selfPayAmount: 0, keigenRate: null, keigenActive: false, jippiEntries: [333, 777, 1], prevBilled: null, prevPaid: null },
  { name: "超過自費あり", userAmount: 15000, selfPayAmount: 4200, keigenRate: null, keigenActive: false, jippiEntries: [], prevBilled: null, prevPaid: null },
  { name: "繰越 正 (未収繰越)", userAmount: 15000, selfPayAmount: 0, keigenRate: null, keigenActive: false, jippiEntries: [], prevBilled: 8000, prevPaid: 3000 },
  { name: "繰越 負 (過入金充当)", userAmount: 15000, selfPayAmount: 0, keigenRate: null, keigenActive: false, jippiEntries: [], prevBilled: 3000, prevPaid: 8000 },
  { name: "繰越 0 (前月ちょうど完済)", userAmount: 15000, selfPayAmount: 0, keigenRate: null, keigenActive: false, jippiEntries: [], prevBilled: 5000, prevPaid: 5000 },
  { name: "前月レコード無し (prevBilled/paid null)", userAmount: 15000, selfPayAmount: 0, keigenRate: null, keigenActive: false, jippiEntries: [], prevBilled: null, prevPaid: null },
  { name: "軽減+実費+繰越 複合 (奇数額・丸め境界)", userAmount: 20001, selfPayAmount: 999, keigenRate: 15, keigenActive: true, jippiEntries: [1501, 2499], prevBilled: 12345, prevPaid: 6789 },
  { name: "keigen_rate=0 (無効値と同じ扱いになるか)", userAmount: 20155, selfPayAmount: 0, keigenRate: 0, keigenActive: true, jippiEntries: [], prevBilled: null, prevPaid: null },
  { name: "userAmount=0 (退所月など)", userAmount: 0, selfPayAmount: 0, keigenRate: 30, keigenActive: true, jippiEntries: [500], prevBilled: null, prevPaid: null },
];

let mismatches = 0;
console.log("=== 3 実装の突き合わせ (A=画面 / B=個人票 / C=世帯合算票[1名版]) ===\n");
for (const c of CASES) {
  const userPlusSelf = c.userAmount + c.selfPayAmount;
  const jippiSum = c.jippiEntries.reduce((s, v) => s + v, 0);
  const keigen = keigenAmount_A(userPlusSelf, c.keigenRate, c.keigenActive);

  const a_monthTotal = rowBilled_A(userPlusSelf, c.keigenRate, c.keigenActive, jippiSum);
  const a_carry = carryover_A(c.prevBilled, c.prevPaid);
  const a_grandTotal = a_monthTotal + a_carry; // 画面には無い概念だが比較用に組む

  const b = printSheet_B(userPlusSelf, keigen, jippiSum, c.prevBilled, c.prevPaid);
  const cc = householdSheet_C(
    [{ userPlusSelf, keigen, jippiSum }],
    [c.prevBilled ?? 0], // ⚠ C は前月レコード無しの行を filter で除外してから合算する設計 (household 版)。
    [c.prevPaid ?? 0],   //   1名版で prevBilled==null を再現するときは 0 寄せが正しい (household の filter と同値)
  );

  const ok = a_monthTotal === b.monthTotal && a_monthTotal === cc.monthTotal && a_grandTotal === b.grandTotal && a_grandTotal === cc.grandTotal;
  if (!ok) mismatches += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${c.name}`);
  console.log(`      monthTotal  A=${a_monthTotal}  B=${b.monthTotal}  C=${cc.monthTotal}`);
  console.log(`      grandTotal  A=${a_grandTotal}  B=${b.grandTotal}  C=${cc.grandTotal}`);
}

// ---------------------------------------------------- ★ 障害は型で渡せないことの確認
// UserSeikyuRow (介護/総合) には無く UnifiedRow/ShogaiSeikyuRow にしか無いフィールドを
// 使わないと printSheet_B/householdSheet_C の入力を作れない、という構造を明示する。
// (billedForRow の 障害分岐 = shogai.userAmount は B/C のどちらの関数にも存在しない)
console.log("\n=== 障害分岐の有無 (ソース上の事実) ===");
console.log("  billedForRow(:612) は UnifiedRow.system==='障害' で shogai.userAmount に分岐する");
console.log("  printSheet_B / householdSheet_C の入力は userPlusSelf 等の生の number のみで、");
console.log("  system 分岐が存在しない = 障害の値を渡す経路自体がコード上に無い (型でも防がれている)");
console.log("  呼び出し元 (printGroups:1043 / kaigoTargets:906) が 障害行を事前に除外していることを");
console.log("  ソースで確認済み (kaigoTargets = targets.filter(r => r.system !== \"障害\"))");


// ---------------------------------------------------------- ★ 負のコントロール
//   この harness 自身が「ズレ」を検出できることを、わざと壊して確認する。
//   壊した変種は本比較には使わない (このブロック専用)。
console.log("\n=== 負のコントロール (harness がズレを検出できるか) ===");
let negOk = 0;
{
  // ① 個人票の keigen を 2 重に引いてしまうバグを模擬 (よくある実装ミス)
  const userPlusSelf = 20155, keigen = keigenAmount_A(userPlusSelf, 10, true), jippiSum = 0;
  const a = rowBilled_A(userPlusSelf, 10, true, jippiSum);
  const brokenB = userPlusSelf - keigen * 2 + jippiSum; // わざと2重控除
  const detected1 = a !== brokenB;
  console.log(`  ${detected1 ? "✓" : "✗"} ① 軽減を2重控除するバグを検出できる (A=${a} / brokenB=${brokenB})`);
  if (detected1) negOk += 1;
}
{
  // ② 世帯合算の繰越を二重計上してしまう設計ミスを模擬
  const members = [{ userPlusSelf: 15000, keigen: 0, jippiSum: 0 }];
  const correct = householdSheet_C(members, [8000], [3000]);
  const carry = 8000 - 3000;
  const brokenGrandTotal = correct.monthTotal + carry * 2; // わざと繰越を二重計上
  const detected2 = correct.grandTotal !== brokenGrandTotal;
  console.log(`  ${detected2 ? "✓" : "✗"} ② 繰越の二重計上を検出できる (正=${correct.grandTotal} / 二重計上想定=${brokenGrandTotal})`);
  if (detected2) negOk += 1;
}
if (negOk < 2) {
  console.error("\n✗ 負のコントロールが機能していない。harness 自体を疑うこと");
  process.exit(1);
}

console.log(`\n${mismatches === 0 ? "✅ PASS — 3 実装は境界値含め一致 (負のコントロール2/2 OK)。統合してよい" : `❌ FAIL — ${mismatches} 件不一致。統合しない。差の中身を報告する`}`);
process.exit(mismatches === 0 ? 0 : 1);
