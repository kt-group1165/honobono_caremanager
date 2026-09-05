/**
 * 移動支援 2人目従業者コード算出 (secondPersonCode, idou-billing-lines.ts) の
 * 直接検証 (DB 不使用)
 *
 *   npx tsx scripts/idou-second-person-code-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   buildIdouMeisaiLines は scripts/check-idou-lines.mts で既に検証されて
 *   おり「2人派遣は+1コードで別行」も間接的にカバーされているが、
 *   secondPersonCode 自体を直接呼ぶテストが無く、コード算出のpadding・
 *   マスタ未登録時のフォールバックが未検証だった。既存スクリプトにも
 *   負のコントロールが1件も無かったため、こちらで補う。
 *
 *   ★ money-safety: 2人目コードの単位は「同額 (×100%)」という仕様
 *   (ファイル冒頭コメント)。base のunitをそのまま複製する設計を固定化する。
 */
import { secondPersonCode, type CodeInfoEntry } from "@/lib/idou-billing-lines";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

const info = new Map<string, CodeInfoEntry>([
  ["023115", { name: "移動1日中1.0", unit: 441 }],
  ["027111", { name: "移動2日中0.5", unit: 116 }],
]);

// ── 基本 ──────────────────────────────────────────────────────────────────
{
  const r = secondPersonCode("023115", info);
  eq("★ コードは base+1 を6桁ゼロ埋め", r.code, "023116");
  eq("★ 名前は base名 + 「・2人」", r.name, "移動1日中1.0・2人");
  eq("★ 単位は base と同額 (×100%。割引しない)", r.unit, 441);
}
{
  const r = secondPersonCode("027111", info);
  eq("別コードでも同じ規則", r, { code: "027112", name: "移動2日中0.5・2人", unit: 116 });
}

// ── ★ マスタ未登録のフォールバック ─────────────────────────────────────────
{
  const r = secondPersonCode("999999", info);
  eq("★ codeInfoに無いコードは name が base コードそのもの + 「・2人」", r.name, "999999・2人");
  eq("★ codeInfoに無いコードは unit が 0 (加算しない安全側)", r.unit, 0);
  eq("★ コード算出自体はマスタの有無に関係なく行われる (6桁を超える繰り上がりは桁が増える)", r.code, "1000000");
}

// ── ゼロ埋めの境界 ────────────────────────────────────────────────────────
eq("★ 下1桁が繰り上がってもゼロ埋め6桁を保つ", secondPersonCode("000009", info).code, "000010");
eq("先頭0を含むコードの通常ケース", secondPersonCode("000100", info).code, "000101");

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① 2人目コードの単位を割引く(例: 半額)壊れた実装 (実際は同額のはず)
  const correct = secondPersonCode("023115", info).unit;
  const broken = Math.floor((info.get("023115")?.unit ?? 0) / 2); // ★ 半額にしてしまう
  const detected1 = correct !== broken;
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: 単位の割引の有無を検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ 2人目コードの単位を割り引く(正は同額)バグを検出できる (正=${correct} / 壊れた版=${broken})`);

  // ② +1 ではなく文字列連結で別コードを作る壊れた実装 (例: base + "2")
  const correct2 = secondPersonCode("023115", info).code;
  const broken2 = "023115" + "2"; // ★ 数値+1ではなく文字列連結にする誤り
  const detected2 = correct2 !== broken2;
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: コード算出方式(+1 vs 文字列連結)の違いを検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ コードを+1ではなく文字列連結で作るバグを検出できる (正=${correct2} / 壊れた版=${broken2})`);
}

console.log(`\n移動支援 2人目従業者コード算出 (secondPersonCode) の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
