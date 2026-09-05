/**
 * 介護/予防 様式判定 (yobo-kubun.ts) の検証 (DB 不使用)
 *
 *   npx tsx scripts/yobo-kubun-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   ファイル冒頭コメント: 居宅介護支援では認定区分によって使う帳票様式が
 *   排他的に決まり、この module が「その唯一の判定元」。1バイトの判定ミスが
 *   全ての居宅系帳票 (アセスメント/計画書/モニタリング) の様式選択を壊す
 *   にもかかわらず、1つも検証されていなかった。
 *
 *   ★ 副産物として、user-sidebar.tsx:743 で「予防」フィルタは isYoboLevel を
 *   使うのに「介護」フィルタは独立した level.startsWith("要介護") を使っている
 *   非対称を発見したが、"経過的要介護" (どちらにも一致しない値) は
 *   migrations/import_cert_history.mjs で取込時点から除外されており DB に
 *   実在しないため、現状は実害なしと確認した (対応不要)。
 */
import { isYoboLevel, formKindForCareLevel, FORM_KIND_LABEL } from "@/lib/yobo-kubun";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

// ── isYoboLevel ───────────────────────────────────────────────────────────
eq("要支援1 は予防", isYoboLevel("要支援1"), true);
eq("要支援2 は予防", isYoboLevel("要支援2"), true);
eq("事業対象者 は予防", isYoboLevel("事業対象者"), true);
eq("要介護1 は予防でない", isYoboLevel("要介護1"), false);
eq("要介護5 は予防でない", isYoboLevel("要介護5"), false);
eq("null は予防でない (falseで安全側=介護扱い)", isYoboLevel(null), false);
eq("undefined は予防でない", isYoboLevel(undefined), false);
eq("空文字は予防でない", isYoboLevel(""), false);
eq("非該当は予防でない", isYoboLevel("非該当"), false);
eq("★ 全角数字 (要支援１) でも「要支援」部分文字列で判定するのでtrue", isYoboLevel("要支援１"), true);

// ── formKindForCareLevel ──────────────────────────────────────────────────
eq("要支援1 → yobo", formKindForCareLevel("要支援1"), "yobo");
eq("事業対象者 → yobo", formKindForCareLevel("事業対象者"), "yobo");
eq("要介護3 → kaigo", formKindForCareLevel("要介護3"), "kaigo");
eq("★ 認定未登録 (null) は既定で kaigo (新規は要介護での依頼が大半という設計判断)", formKindForCareLevel(null), "kaigo");
eq("★ 認定未登録 (空文字) も既定で kaigo", formKindForCareLevel(""), "kaigo");
eq("未知の文字列も kaigo (フォールバック)", formKindForCareLevel("謎の区分"), "kaigo");

// ── FORM_KIND_LABEL ───────────────────────────────────────────────────────
eq("kaigo の表示名は「介護」", FORM_KIND_LABEL.kaigo, "介護");
eq("yobo の表示名は「予防」", FORM_KIND_LABEL.yobo, "予防");

// ── 排他性の恒等式 (3-14): 全ケースで kaigo と yobo が同時に真にならない ────
{
  const samples = ["要支援1", "要支援2", "事業対象者", "要介護1", "要介護2", "要介護3", "要介護4", "要介護5", null, "", "非該当"];
  let violations = 0;
  for (const s of samples) {
    const yobo = isYoboLevel(s);
    const kind = formKindForCareLevel(s);
    if (yobo && kind !== "yobo") violations++;
    if (!yobo && kind !== "kaigo") violations++;
  }
  eq("★ isYoboLevel と formKindForCareLevel は全サンプルで整合する (排他的2値)", violations, 0);
}

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① 正規表現に「事業対象者」を含めない壊れた実装 (総合事業の利用者が介護版に誤判定される)
  const brokenIsYoboLevel = (careLevel: string | null | undefined): boolean =>
    !!careLevel && /要支援/.test(careLevel); // ★ 事業対象者 が抜けている
  const correct = isYoboLevel("事業対象者");
  const broken = brokenIsYoboLevel("事業対象者");
  const detected1 = correct !== broken;
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: 事業対象者の判定漏れを検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ 正規表現から「事業対象者」を落とすバグを検出できる (正=${correct} / 壊れた版=${broken})`);

  // ② 認定未登録時の既定値を yobo にしてしまう壊れた実装 (新規利用者が予防版になる事故)
  const correct2 = formKindForCareLevel(null);
  const broken2: "kaigo" | "yobo" = "yobo"; // ★ 既定を逆にする
  const detected2 = correct2 !== broken2;
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: 未登録時の既定値の違いを検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ 認定未登録時の既定をyoboにする(新規利用者が予防版になる)バグを検出できる (正=${correct2} / 壊れた版=${broken2})`);
}

console.log(`\n介護/予防 様式判定 (唯一の判定元) の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
