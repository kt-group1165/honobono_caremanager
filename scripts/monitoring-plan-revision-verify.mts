/**
 * kaigo_monitoring_items.plan_revision_needed の DB(boolean) ⇔ 画面(文字列) 変換の検証 (DB 不使用)
 *
 *   npx tsx scripts/monitoring-plan-revision-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   2026-09-14 発見: DB列はboolean・画面stateは"あり"/"なし"/""の文字列で、
 *   境界で変換していなかった (実運用0行のため未発火のバグ)。
 *   src/lib/monitoring-plan-revision.ts に切り出した2関数の境界だけを検証する。
 */
import { dbToRevisionNeeded, revisionNeededToDb } from "../src/lib/monitoring-plan-revision";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

// ── dbToRevisionNeeded: DB → 画面 ──────────────────────────────────────────
eq("true → あり", dbToRevisionNeeded(true), "あり");
eq("false → なし", dbToRevisionNeeded(false), "なし");
eq("null → 空文字 (未入力)", dbToRevisionNeeded(null), "");
eq("undefined → 空文字 (未入力)", dbToRevisionNeeded(undefined), "");

// ── revisionNeededToDb: 画面 → DB ──────────────────────────────────────────
eq("あり → true", revisionNeededToDb("あり"), true);
eq("なし → false", revisionNeededToDb("なし"), false);
eq("空文字 → null (未入力。falseにしない)", revisionNeededToDb(""), null);
eq("★ 想定外の文字列 → null (未入力に倒す。決め打ちしない)", revisionNeededToDb("不明"), null);

// ── 往復 (round-trip) ──────────────────────────────────────────────────────
eq("true → あり → true", revisionNeededToDb(dbToRevisionNeeded(true)), true);
eq("false → なし → false", revisionNeededToDb(dbToRevisionNeeded(false)), false);
eq("null → 空文字 → null", revisionNeededToDb(dbToRevisionNeeded(null)), null);

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // 境界変換をしない (バグ当時の実装) だと、falseがDEFAULT(false)と区別できず
  // 「未入力」と「なし」が同じ値になる。この崩れを検出できるか確認する。
  const brokenSave = (v: string) => (v || null); // ★ 変換せずそのまま送る旧実装
  const correctEmpty = revisionNeededToDb("");
  const brokenEmpty = brokenSave("");
  const detected1 = correctEmpty === null && brokenEmpty === null; // 空文字はどちらもnullで一致 (これは元々問題ない)
  // ★ 本当の問題は "あり"/"なし" という文字列そのものをboolean列に送ってしまうこと
  const brokenAri = brokenSave("あり"); // "あり" (文字列のまま)
  const correctAri = revisionNeededToDb("あり"); // true (boolean)
  const detected2 = typeof brokenAri === "string" && typeof correctAri === "boolean";
  if (detected1 && detected2) pass++;
  else fails.push("★ 負のコントロールが鳴らない: 型変換の欠落を検出できていない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ 旧実装(変換なし)は文字列"あり"をboolean列に送ろうとする型不一致を検出できる`);
}

console.log(`\nplan_revision_needed 変換の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
