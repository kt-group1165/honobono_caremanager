/**
 * kaigo_service_codes.formula → 実単位値 の計算 (src/lib/service-code-calc.ts) を検証
 * (DB 不使用・純関数。READ ONLY で実データの形だけ先に確認する)
 *
 *   npx tsx scripts/service-code-calc-verify.mts
 *
 * ── まず配線を確認した (2026-09-05) ────────────────────────────────────
 *   H の割当は「今日踏んだ 441/1000 の計算もここのはず」だったが、★ 前提が誤っていた。
 *
 *   grep -rl "calculateUnits" . → ★ 呼出元は service-code-calc.ts 自身だけ (0件)。
 *   grep -rl "from \"@/lib/service-code-calc\"" src/
 *     → master/service-codes-content.tsx が **formulaToDescription だけ**を使っている
 *       (「計算式: ...」という説明文の表示のみ。実際の単位数計算には使っていない)。
 *
 *   ★ つまり calculateUnits (このファイルの本体) は ★ 現在どこからも呼ばれていない。
 *   実際の 処遇改善加算等の % 計算は、制度ごとに **別々にインライン実装**されている:
 *     claims-shared.ts calcTotals()          (居宅介護支援)
 *     visit-seikyu/aggregate.ts (該当箇所)    (訪問介護)
 *     visit-seikyu/aggregate-sougou.ts        (総合事業)
 *     shogai-seikyu/aggregate.ts              (障害。今日の 441/1000 はここ)
 *   ★ 今日踏んだ 441/1000 の計算は shogai-seikyu/aggregate.ts の
 *     `Math.round((subtotal * f.numerator) / f.denominator)` (インライン) であって、
 *     このファイルの calculateUnits ではなかった。
 *
 *   → このファイル自体は ★ バグではない (未配線なだけ)。ただし
 *     「本来ここに一本化されるべき計算が、制度の数だけ再実装されている」状態で、
 *     3-14 (同じ事実を複数箇所に持つと必ず食い違う) のリスクを抱えている。
 *     ★ 直さない。乖離を見つけたら報告のみ (H の指示どおり)。
 *
 * ── 実データの形 (2026-09-05 実測) ────────────────────────────────────
 *   formula.type は ★ monthly_aggregate が 496/496 件 (100%)。
 *   time_increment / multiplier / chain は ★ 実データに1件も無い
 *     (TypeScript の型定義上は存在するが、マスタには一度も入っていない)。
 *   rounding は ★ round のみ (未指定=既定roundも含め 496/496)。floor/ceil/none は実データ0件。
 *   numerator は 100種 (270/1000 等)・負の値は0件・0 が6件 (0%レート、実在)。
 *
 * ★ この検査が証明しないこと (ルール 3-1):
 *   - 実際の請求計算がこの関数を通っているか (通っていない。上記のとおり)
 *   - time_increment / multiplier / chain の実データでの正しさ (実データが無いため
 *     コードで分かる範囲のみ。境界値は仕様どおりに実装されているかを見る)
 *   - floor/ceil/none rounding の実データでの正しさ (同上)
 */
import {
  calculateUnits,
  indexByServiceCode,
  formulaToDescription,
  type MinimalServiceCode,
  type ServiceCodeFormula,
} from "@/lib/service-code-calc";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  OK   ${label}`); }
  else { fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`); console.log(`  FAIL ${label}\n         期待: ${JSON.stringify(want)}\n         実際: ${JSON.stringify(got)}`); }
};

const rec = (code: string, units: number, formula: ServiceCodeFormula | null = null): MinimalServiceCode =>
  ({ service_code: code, units, formula });

console.log("=== §1 monthly_aggregate (実データ496/496件がこの type) ===");
{
  // 今日 shogai-seikyu/aggregate.ts で実測した 441/1000 (同行援護処遇改善加算Ⅱロ) と
  // 同じ値で cross-check する。期待値はインライン実装の出力からコピーしていない —
  // 告示の式 (所定単位×rate) をそのまま独立計算する。
  const idx = indexByServiceCode([rec("157695", 229)]);
  const f: ServiceCodeFormula = { type: "monthly_aggregate", numerator: 441, denominator: 1000, rounding: "round" };
  const r = calculateUnits({ ...idx["157695"], formula: f }, idx, { monthly_total_units: 229 });
  eq("441/1000 (今日の同行援護区分3と同じ入力) → round(229×441/1000)=101", r, Math.round((229 * 441) / 1000));
  eq("↑ 数値としても101", r, 101);
}
{
  // 居宅介護支援の処遇改善 21/1000 (今日 kyotaku-matrix-verify.mts §1 で確認した値)
  const idx = indexByServiceCode([rec("436191", 1086)]);
  const f: ServiceCodeFormula = { type: "monthly_aggregate", numerator: 21, denominator: 1000 }; // rounding省略=既定round
  const r = calculateUnits({ ...idx["436191"], formula: f }, idx, { monthly_total_units: 1086 });
  eq("rounding省略時は既定でround。21/1000×1086 → round(22.806)=23", r, 23);
}
{
  // ★ numerator=0 (実データに6件実在)。0除算にならず0を返すこと
  const idx = indexByServiceCode([rec("466191", 0)]);
  const f: ServiceCodeFormula = { type: "monthly_aggregate", numerator: 0, denominator: 1000 };
  const r = calculateUnits({ ...idx["466191"], formula: f }, idx, { monthly_total_units: 1000 });
  eq("★ numerator=0 (実在) → 0", r, 0);
}
{
  // monthly_total_units が渡されない = 集計未実施 → null (UI「要月集計」)。0 にすり替えない
  const idx = indexByServiceCode([rec("X", 100)]);
  const f: ServiceCodeFormula = { type: "monthly_aggregate", numerator: 200, denominator: 1000 };
  const r = calculateUnits({ ...idx["X"], formula: f }, idx, {});
  eq("monthly_total_units 未指定 → null (0 にしない)", r, null);
}
console.log("\n  ⚠ rounding の floor/ceil/none は実データ0件。以下は★コードのみの検証:");
{
  // round-half の境界: 100 × 5/1000 = 0.5。JS Math.round は 0.5 を +Infinity 側に丸める
  const idx = indexByServiceCode([rec("X", 100)]);
  const base: ServiceCodeFormula = { type: "monthly_aggregate", numerator: 5, denominator: 1000 };
  eq("★ 境界値 0.5 → round既定 (JSのMath.round=+Infinity側)", calculateUnits({ ...idx["X"], formula: { ...base, rounding: "round" } }, idx, { monthly_total_units: 100 }), 1);
  eq("★ 境界値 0.5 → floor", calculateUnits({ ...idx["X"], formula: { ...base, rounding: "floor" } }, idx, { monthly_total_units: 100 }), 0);
  eq("★ 境界値 0.5 → ceil", calculateUnits({ ...idx["X"], formula: { ...base, rounding: "ceil" } }, idx, { monthly_total_units: 100 }), 1);
  eq("★ 境界値 0.5 → none (丸めない)", calculateUnits({ ...idx["X"], formula: { ...base, rounding: "none" } }, idx, { monthly_total_units: 100 }), 0.5);
}

console.log("\n=== §2 multiplier (実データ0件。コードのみ検証) ===");
{
  const idx = indexByServiceCode([rec("BASE", 1000)]);
  const f: ServiceCodeFormula = { type: "multiplier", base_code: "BASE", factor: 1.25, rounding: "round" };
  const r = calculateUnits({ ...idx["BASE"], service_code: "X25", formula: f }, idx, {});
  eq("base_code 参照 + factor1.25 (25%加算) → round(1000×1.25)=1250", r, 1250);
}
{
  // base_code が index に無い (欠落) → null で fail-closed。0 や誤値にしない
  const idx = indexByServiceCode([rec("BASE", 1000)]);
  const f: ServiceCodeFormula = { type: "multiplier", base_code: "存在しないコード", factor: 1.25 };
  const r = calculateUnits({ ...idx["BASE"], service_code: "X", formula: f }, idx, {});
  eq("★ base_code が index に無い → null (fail-closed。0にすり替えない)", r, null);
}

console.log("\n=== §3 time_increment (実データ0件。コードのみ検証) ===");
console.log("  ⚠ ★ 発見: ドキュメント (「加算が始まる最小利用分 (例: 240=4時間以上)」) と");
console.log("    実装の閾値がズレている。以下は自分の想定 (239分=加算前) が誤りで、");
console.log("    実装の実際の挙動 (min_minutes − increment_minutes = 210分 が本当の閾値) に");
console.log("    書き直した経緯。★ どちらが「正しい」かは判断していない (実データ0件で");
console.log("    裏取りできない)。事実として観測した挙動をそのまま記録する:");
{
  // 4時間(240分)以上、30分ごとに+82単位、というドキュメント上の説明を模して作ったが、
  // 実装は「加算 0 回」の境界を min_minutes ではなく (min_minutes − increment_minutes)
  // で判定していた。★ 自分の期待値 239分→base のみ、が誤りだった (規律3-2)。
  const idx = indexByServiceCode([rec("BASE", 500)]);
  const f: ServiceCodeFormula = { type: "time_increment", base_units: 500, increment_unit: 82, increment_minutes: 30, min_minutes: 240 };
  const noAddonBoundary = f.min_minutes - f.increment_minutes; // 実装が実際に見ている閾値 = 210
  eq(`${noAddonBoundary - 1}分 (実装の閾値未満) → 加算前の base のみ`,
    calculateUnits({ ...idx["BASE"], formula: f }, idx, { minutes: noAddonBoundary - 1 }), 500);
  eq(`★ ${noAddonBoundary}分 (実装の閾値ちょうど) → まだ加算前`,
    calculateUnits({ ...idx["BASE"], formula: f }, idx, { minutes: noAddonBoundary }), 500);
  eq(`${noAddonBoundary + 1}分 (閾値+1分) → 1回分に切り上げ`,
    calculateUnits({ ...idx["BASE"], formula: f }, idx, { minutes: noAddonBoundary + 1 }), 500 + 82);
  eq("★ ドキュメント記載の240分 (min_minutes ちょうど) では既に1回分加算されている",
    calculateUnits({ ...idx["BASE"], formula: f }, idx, { minutes: 240 }), 500 + 82);
  eq("270分 (min_minutesから+30=ちょうど2回分の境界) → 加算2回分",
    calculateUnits({ ...idx["BASE"], formula: f }, idx, { minutes: 270 }), 500 + 82 * 2);
  eq("★ minutes 未指定 → params.minutes ?? f.min_minutes = 240分として計算 (base + 1回分)",
    calculateUnits({ ...idx["BASE"], formula: f }, idx, {}), 500 + 82);
}

console.log("\n=== §4 chain (実データ0件。コードのみ検証) ===");
{
  const idx = indexByServiceCode([rec("BASE", 1000)]);
  const f: ServiceCodeFormula = {
    type: "chain",
    steps: [{ base_code: "BASE" }, { factor: 1.1, rounding: "round" }, { factor: 0.9, rounding: "floor" }],
  };
  // 1000 → ×1.1=1100(round) → ×0.9=990(floor) — 各段が独立に丸められることを確認
  eq("chain: BASE→×1.1(round)→×0.9(floor)", calculateUnits({ ...idx["BASE"], formula: f }, idx, {}), 990);
}

console.log("\n=== §5 循環参照ガード (depth>8) ===");
{
  // A→B→A の循環。無限ループせず null で止まることを確認 (実装コメント「最大8段」)
  const idx = indexByServiceCode([
    rec("A", 100, { type: "multiplier", base_code: "B", factor: 1.0 }),
    rec("B", 100, { type: "multiplier", base_code: "A", factor: 1.0 }),
  ]);
  const r = calculateUnits(idx["A"], idx, {});
  eq("★ 循環参照は無限ループせず null で止まる", r, null);
}

console.log("\n=== §6 formula=null (実装コメント「formulaがNULLならrecord.unitsをそのまま返す」) ===");
{
  const idx = indexByServiceCode([rec("PLAIN", 1234, null)]);
  eq("formula=null → record.units をそのまま返す", calculateUnits(idx["PLAIN"], idx, {}), 1234);
}

console.log("\n=== §7 formulaToDescription (実際に配線されている唯一の関数) ===");
{
  const f: ServiceCodeFormula = { type: "monthly_aggregate", numerator: 441, denominator: 1000, label: "所定単位×441/1000 加算" };
  eq("label があればそれを優先", formulaToDescription(f), "所定単位×441/1000 加算");
  const f2: ServiceCodeFormula = { type: "monthly_aggregate", numerator: 441, denominator: 1000 };
  eq("label 無しは自動生成 (44.1%)", formulaToDescription(f2), "月所定単位合計 × 441/1000 (44.1%)");
}

console.log("\n=== 負のコントロール (ルール 3-9) ===");
{
  const before = fails.length;
  eq("★ わざと誤った期待値", calculateUnits(indexByServiceCode([rec("X", 100)])["X"], {}, {}), 999);
  const caught = fails.length === before + 1;
  console.log(`  ${caught ? "OK" : "✗"} 検査は${caught ? "生きている" : "動いていない"}`);
  if (caught) { fails.pop(); pass++; } else fails.push("負のコントロールが機能しない");
}

console.log(`\n=== 結果: PASS ${pass} / FAIL ${fails.length} ===`);
console.log("\n★ 総括 (report-only。直していない):");
console.log("  ① 配線: calculateUnits はどこからも呼ばれていない (formulaToDescription だけが");
console.log("     master画面の説明文表示に使われている)。実際の処遇改善加算等の計算は");
console.log("     claims-shared.ts / visit-seikyu/aggregate.ts / aggregate-sougou.ts /");
console.log("     shogai-seikyu/aggregate.ts に制度ごと別々にインライン実装されている。");
console.log("  ② monthly_aggregate (実データ496/496件): 今日の実測値 441/1000・21/1000 と一致。");
console.log("     numerator=0 (実在6件) も正しく0を返す。乖離なし。");
console.log("  ③ ★ time_increment のドキュメントと実装の閾値ズレ (実データ0件・影響なしだが記録):");
console.log("     コメント「加算が始まる最小利用分 (例: 240=4時間以上)」に対し、");
console.log("     実装は (min_minutes − increment_minutes) を無加算の閾値として使っており、");
console.log("     min_minutes ちょうどの時点で ★ 既に1回分加算済みになる。");
console.log("     どちらが意図した挙動かは実データが無く判断できない。formula.type にこの型を");
console.log("     使う日が来たら、告示の実際の閾値と突き合わせてから使うこと。");
console.log("  ④ multiplier/chain (実データ0件): fail-closed (base_code欠落でnull) 含め想定どおり。");
if (fails.length > 0) process.exit(1);
