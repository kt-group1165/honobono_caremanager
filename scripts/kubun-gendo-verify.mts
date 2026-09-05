/**
 * 区分支給限度基準額 (kubun-gendo.ts) の純関数部分の検証 (DB 不使用)
 *
 *   npx tsx scripts/kubun-gendo-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   ファイル冒頭コメント: 2026-08-31 の監査で認定の service_limit_amount が
 *   告示値と食い違う利用者が実データで 12 名 (超過判定が早まる/検出できない
 *   の両方向)見つかった。standardLimitUnits/limitAmountMismatchReason は
 *   これまで未検証だった。
 *
 *   ★ 同じ表 (CARE_LEVEL_LIMITS) が2箇所に逐語コピーされている
 *   (kubun-gendo.ts 冒頭コメント自身が明記):
 *     benefits-content.tsx:64  — 現状 eslint-disable付きの未使用placeholder
 *     reports-content.tsx:257  — careLevelLimit() で実際に使われている
 *   VERIFICATION_RULES.md 3-14 (同じ事実を2箇所に持つ列は必ず食い違う)と
 *   同型なので、値がずれていないかの静的同期チェックも行う。
 *   ⚠ コピーを1箇所に寄せる作業自体は「別セッションが触っている最中」と
 *   冒頭コメントにあるため、ここでは行わない (寄せるのは別session/別タスク)。
 */
import { readFileSync } from "node:fs";
import {
  CARE_LEVEL_LIMIT_UNITS,
  standardLimitUnits,
  limitAmountMismatchReason,
} from "@/lib/kubun-gendo";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

// ── standardLimitUnits ────────────────────────────────────────────────────
eq("要介護1 → 16765", standardLimitUnits("要介護1"), 16765);
eq("要介護5 → 36217", standardLimitUnits("要介護5"), 36217);
eq("要支援1 → 5032", standardLimitUnits("要支援1"), 5032);
eq("★ 全角数字 (要介護３) も NFKC で正規化して引ける", standardLimitUnits("要介護３"), 27048);
eq("★ 前後の空白を除去して引ける", standardLimitUnits(" 要介護1 "), 16765);
eq("未知の要介護度は null", standardLimitUnits("要介護6"), null);
eq("null は null", standardLimitUnits(null), null);
eq("undefined は null", standardLimitUnits(undefined), null);
eq("空文字は null", standardLimitUnits(""), null);

// ── limitAmountMismatchReason ─────────────────────────────────────────────
eq("告示値と一致 → 問題なし (null)", limitAmountMismatchReason("要介護1", 16765), null);
eq("★ 要介護度が引けない場合は判定しない (null)", limitAmountMismatchReason("要介護6", 12345), null);
{
  const msg = limitAmountMismatchReason("要介護1", null);
  eq("★ 未登録 (null) は警告文を返す", msg !== null, true);
  eq("未登録警告に告示値を含む", msg?.includes("16,765"), true);
}
{
  const msg = limitAmountMismatchReason("要介護4", 16765); // 実例: 山中英子 (超過判定が早まる方向)
  eq("★ 過少値の食い違いを検出する (山中英子の実例と同じ形)", msg !== null, true);
  eq("食い違い警告に登録値・告示値の両方を含む", [msg?.includes("16,765"), msg?.includes("30,938")], [true, true]);
}
{
  const msg = limitAmountMismatchReason("要介護1", 27048); // 実例: 杉谷久 (超過を検出できない方向)
  eq("★ 過大値の食い違いも検出する (杉谷久の実例と同じ形)", msg !== null, true);
}
eq("registered が 0 (falsy だが null ではない) も食い違いとして扱う", limitAmountMismatchReason("要介護1", 0) !== null, true);

// ── ★ 逐語コピー2箇所との同期チェック (静的解析。実行はしない) ────────────
{
  const readObj = (path: string): Record<string, number> | null => {
    const src = readFileSync(path, "utf8");
    const m = /CARE_LEVEL_LIMITS\s*:\s*Record<string,\s*number>\s*=\s*\{([\s\S]*?)\}/.exec(src);
    if (!m) return null;
    const out: Record<string, number> = {};
    for (const line of m[1].split("\n")) {
      const kv = /^\s*(\S+?)\s*:\s*(\d+)\s*,?\s*$/.exec(line);
      if (kv) out[kv[1]] = Number(kv[2]);
    }
    return out;
  };

  const benefits = readObj("src/app/(authenticated)/billing/benefits/benefits-content.tsx");
  const reports = readObj("src/app/(authenticated)/reports/[type]/reports-content.tsx");

  eq("★ benefits-content.tsx の複製が読める (ファイル構造が変わっていない)", benefits !== null, true);
  eq("★ reports-content.tsx の複製が読める (ファイル構造が変わっていない)", reports !== null, true);

  if (benefits) {
    eq("★ benefits-content.tsx の複製が kubun-gendo.ts と一致している (現状は未使用placeholder)", benefits, CARE_LEVEL_LIMIT_UNITS);
  }
  if (reports) {
    eq("★ reports-content.tsx の複製が kubun-gendo.ts と一致している (こちらは実際に使われている)", reports, CARE_LEVEL_LIMIT_UNITS);
  }
}

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① NFKC 正規化を忘れる壊れた実装 (全角数字を引けない)
  const brokenStandardLimitUnits = (careLevel: string | null | undefined): number | null => {
    if (!careLevel) return null;
    const key = careLevel.replace(/\s/g, ""); // ★ normalize("NFKC") を忘れる
    return CARE_LEVEL_LIMIT_UNITS[key] ?? null;
  };
  const correct = standardLimitUnits("要介護３");
  const broken = brokenStandardLimitUnits("要介護３");
  const detected1 = correct !== broken;
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: NFKC正規化の有無を検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ NFKC正規化を忘れる(全角数字を引けない)バグを検出できる (正=${correct} / 壊れた版=${broken})`);

  // ② registered==null の判定を !registered にする壊れた実装 (0 を未登録扱いしてしまう)
  const brokenMismatch = (careLevel: string, registered: number | null | undefined): string | null => {
    const std = standardLimitUnits(careLevel);
    if (std == null) return null;
    if (!registered) return "未登録"; // ★ registered===0 も未登録扱いになる (正は == null)
    if (registered !== std) return "食い違い";
    return null;
  };
  const correct2 = limitAmountMismatchReason("要介護1", 0);
  const broken2 = brokenMismatch("要介護1", 0);
  const detected2 = correct2 !== broken2 && correct2?.includes("一致しません") === true;
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: registered=0 の未登録誤判定を検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ registered=0 を未登録と誤判定する(!registeredで書く)バグを検出できる (正=${correct2} / 壊れた版=${broken2})`);
}

console.log(`\n区分支給限度基準額 (純関数部分 + 2箇所の逐語コピーとの同期) の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
