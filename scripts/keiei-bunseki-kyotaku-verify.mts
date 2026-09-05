/**
 * 経営分析 共有データ層 (keiei-bunseki.ts) 居宅系 + ヒートマップ配色 の
 * 純関数部分の検証 (DB 不使用)
 *
 *   npx tsx scripts/keiei-bunseki-kyotaku-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   keiei-bunseki-verify.mts (訪問系) の続き。computeKyotakuAnalysis は
 *   訪問系の computeVisitAnalysis と同じ「前月0件/4倍以上の差」ガードを
 *   持つ独立実装 (逐語コピーではなく別関数として書かれている) — 3-14の
 *   「同じ事実を2箇所に持つ」パターンに近いので、両方が同じ境界で動くことを
 *   個別に確認する。heatStyle/heatStyleRed も未検証だった。
 *
 *   ★ clientFilter (自事業所スコープ) の inScope 判定に
 *   「user_id が null なら無条件でスコープ内」という設計 (!id || ...) がある。
 *   これは claims.user_id が null になりうる (型が string|null) ことへの
 *   fail-open な扱いで、意図的か確認が必要な箇所として明示的にテストする。
 */
import {
  computeKyotakuAnalysis,
  heatStyle,
  heatStyleRed,
  type KyotakuMonthData,
} from "@/lib/keiei-bunseki";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

// ── computeKyotakuAnalysis: 基本集計 ──────────────────────────────────────
{
  const data: KyotakuMonthData = {
    month: "2026-06",
    benefitUserIds: ["c1", "c2", "c2", "c3"], // c2 は複数サービス行で重複しうる
    claims: [
      { user_id: "c1", units: 1000, insurance_amount: 9000 },
      { user_id: "c2", units: 500, insurance_amount: 4500 },
      { user_id: null, units: 100, insurance_amount: 900 }, // 異常行 (user_id無し)
    ],
  };
  const byMonth = new Map([["2026-06", data]]);
  const r = computeKyotakuAnalysis(["2026-06"], "2026-05", byMonth, null)[0];
  eq("★ kanriUsers は benefitUserIds のユニーク数 (重複するc2は1名)", r.kanriUsers, 3);
  eq("claimCount は claims の行数 (user_id null 行も含む)", r.claimCount, 3);
  eq("unitsSum は claims の units 合計", r.unitsSum, 1600);
  eq("amountSum は claims の insurance_amount 合計", r.amountSum, 9000 + 4500 + 900);
}

// ── clientFilter (自事業所スコープ) ────────────────────────────────────────
{
  const data: KyotakuMonthData = {
    month: "2026-06",
    benefitUserIds: ["c1", "c2"],
    claims: [
      { user_id: "c1", units: 1000, insurance_amount: 9000 },
      { user_id: "c2", units: 500, insurance_amount: 4500 }, // c2 はスコープ外
      { user_id: null, units: 100, insurance_amount: 900 },
    ],
  };
  const byMonth = new Map([["2026-06", data]]);
  const filter = new Set(["c1"]);
  const r = computeKyotakuAnalysis(["2026-06"], "2026-05", byMonth, filter)[0];
  eq("★ clientFilter で絞ると kanriUsers はスコープ内利用者のみ (c2を除外)", r.kanriUsers, 1);
  eq("★ claimCount もスコープ内のみ (c2の請求行を除外)、ただし user_id=null 行は含む", r.claimCount, 2);
  eq("★ user_id=null の請求行は clientFilter があってもスコープ内として金額に加算される (fail-open)", r.amountSum, 9000 + 900);
}

// ── newUsers/endedUsers のガード (訪問系と同じ境界規則) ────────────────────
{
  const mk = (ids: string[]): KyotakuMonthData => ({ month: "x", benefitUserIds: ids, claims: [] });

  // (a) 前月0件 → 判定不能
  const byMonth1 = new Map([["2026-05", mk([])], ["2026-06", mk(["c1", "c2"])]]);
  const r1 = computeKyotakuAnalysis(["2026-06"], "2026-05", byMonth1, null)[0];
  eq("★ 前月0件は newUsers/endedUsers が null", [r1.newUsers, r1.endedUsers], [null, null]);

  // (b) 正常時: 差分を正しく検出
  const byMonth2 = new Map([
    ["2026-05", mk(["a", "b", "c", "d"])],
    ["2026-06", mk(["b", "c", "d", "e"])],
  ]);
  const r2 = computeKyotakuAnalysis(["2026-06"], "2026-05", byMonth2, null)[0];
  eq("★ 新規1名(e)/終了1名(a)を正しく検出", [r2.newUsers, r2.endedUsers], [1, 1]);

  // (c) 4倍以上の差 → 判定不能 (訪問系と同じガード)
  const byMonth3 = new Map([
    ["2026-05", mk(["x"])],
    ["2026-06", mk(Array.from({ length: 20 }, (_, i) => `u${i}`))],
  ]);
  const r3 = computeKyotakuAnalysis(["2026-06"], "2026-05", byMonth3, null)[0];
  eq("★ 4倍以上の実績量差は判定不能 (訪問系と同じ境界規則を独立実装で満たす)", [r3.newUsers, r3.endedUsers], [null, null]);
}

// ── heatStyle ─────────────────────────────────────────────────────────────
eq("v=0 は undefined (無色)", heatStyle(0, 100), undefined);
eq("max<=0 は undefined", heatStyle(50, 0), undefined);
eq("★ v>0 かつ max>0 は色が付く", heatStyle(50, 100) !== undefined, true);
{
  const s = heatStyle(50, 100) as { backgroundColor: string; color?: string };
  eq("★ alpha = 0.1 + (v/max)*0.55 (v=50,max=100→0.375)", s.backgroundColor, "rgba(99, 102, 241, 0.375)");
  eq("★ alpha<=0.42 の間は文字色を白にしない (undefined)", s.color, undefined);
}
{
  const s = heatStyle(100, 100) as { backgroundColor: string; color?: string };
  eq("★ v=max (alpha計算上は0.65) でも上限0.8にクランプされない範囲では計算通り", s.backgroundColor, "rgba(99, 102, 241, 0.650)");
  eq("★ alpha>0.42 になったら白文字にする", s.color, "#fff");
}
eq("★ alpha は最大0.8でクランプされる (v>>max)", (heatStyle(10000, 100) as { backgroundColor: string }).backgroundColor, "rgba(99, 102, 241, 0.800)");

// ── heatStyleRed ──────────────────────────────────────────────────────────
eq("v=0 は undefined", heatStyleRed(0, 100), undefined);
{
  const s = heatStyleRed(50, 100) as { backgroundColor: string };
  eq("★ heatStyle と同じ alpha 式だが色は red 系 (239,68,68)", s.backgroundColor, "rgba(239, 68, 68, 0.375)");
}

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① clientFilter で user_id=null 行も除外してしまう壊れた実装
  const data: KyotakuMonthData = {
    month: "2026-06",
    benefitUserIds: [],
    claims: [{ user_id: null, units: 100, insurance_amount: 900 }],
  };
  const byMonth = new Map([["2026-06", data]]);
  const filter = new Set(["c1"]); // null行を含まないフィルタ
  const correct = computeKyotakuAnalysis(["2026-06"], "2026-05", byMonth, filter)[0];
  const brokenInScope = (id: string | null) => !!id && filter.has(id); // ★ !id を落として null行を除外してしまう
  const brokenAmountSum = data.claims.filter((c) => brokenInScope(c.user_id)).reduce((s, c) => s + c.insurance_amount, 0);
  const detected1 = correct.amountSum !== brokenAmountSum;
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: null行のfail-open扱いを検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ user_id=null行をclientFilterで除外してしまうバグを検出できる (正=${correct.amountSum} / 壊れた版=${brokenAmountSum})`);

  // ② heatStyle の alpha クランプ上限を無くす壊れた実装
  const correctStyle = heatStyle(10000, 100) as { backgroundColor: string };
  const brokenAlpha = 0.1 + (10000 / 100) * 0.55; // ★ Math.min(0.8, ...) を忘れる
  const brokenStyle = `rgba(99, 102, 241, ${brokenAlpha.toFixed(3)})`;
  const detected2 = correctStyle.backgroundColor !== brokenStyle;
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: alphaクランプの有無を検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ alphaのクランプ(0.8上限)を忘れるバグを検出できる (正=${correctStyle.backgroundColor} / 壊れた版=${brokenStyle})`);
}

console.log(`\n経営分析 共有データ層 (純関数部分・居宅系+配色) の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
