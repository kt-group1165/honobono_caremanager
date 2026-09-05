/**
 * 居宅介護支援費 加算の月次有効判定 (isAddonActiveInMonth) / 地域単価解決
 * (getUnitPriceByArea) の検証 (DB 不使用)
 *
 *   npx tsx scripts/kyotaku-addon-active-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   claims-content.tsx:1041 で実際の請求集計に使われる純関数だが、
 *   scripts/kyotaku-matrix-verify.mts は computeKyotakuMatrixUpdate だけを
 *   カバーしており、この2関数は検証されていなかった。
 *
 *   規則 (claims-shared.ts のコメント通り):
 *     isAddonActiveInMonth:
 *       status='active' かつ applied_from <= 月末日 かつ
 *       (expires_at IS NULL または expires_at >= 月初日)
 *     getUnitPriceByArea:
 *       area_category → 単位数単価。未知/null は「その他」(10.00円) にフォールバック
 */
import {
  isAddonActiveInMonth,
  getUnitPriceByArea,
  AREA_UNIT_PRICE_TABLE,
} from "@/app/(authenticated)/billing/claims/claims-shared";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

const addon = (o: { status?: string; applied_from: string; expires_at?: string | null }) => ({
  status: o.status ?? "active",
  applied_from: o.applied_from,
  expires_at: o.expires_at ?? null,
});

// ── status ───────────────────────────────────────────────────────────────
eq("status が active でなければ (draft) false", isAddonActiveInMonth(addon({ status: "draft", applied_from: "2026-01-01" }), "2026-06"), false);
eq("status が active でなければ (expired) 期間内でも false", isAddonActiveInMonth(addon({ status: "expired", applied_from: "2026-01-01" }), "2026-06"), false);

// ── applied_from の境界 (月末以前なら有効) ─────────────────────────────
eq("applied_from が対象月より前", isAddonActiveInMonth(addon({ applied_from: "2026-05-01" }), "2026-06"), true);
eq("★ applied_from が対象月の月初ちょうど", isAddonActiveInMonth(addon({ applied_from: "2026-06-01" }), "2026-06"), true);
eq("★ applied_from が対象月の月末ちょうど (境界含む)", isAddonActiveInMonth(addon({ applied_from: "2026-06-30" }), "2026-06"), true);
eq("★ applied_from が対象月の翌月1日 (境界の次) は false", isAddonActiveInMonth(addon({ applied_from: "2026-07-01" }), "2026-06"), false);

// ── expires_at の境界 (月初以降なら有効) ───────────────────────────────
eq("expires_at が null なら期限なし (true)", isAddonActiveInMonth(addon({ applied_from: "2026-01-01", expires_at: null }), "2026-06"), true);
eq("expires_at が対象月より後", isAddonActiveInMonth(addon({ applied_from: "2026-01-01", expires_at: "2026-07-01" }), "2026-06"), true);
eq("★ expires_at が対象月の月初ちょうど (境界含む)", isAddonActiveInMonth(addon({ applied_from: "2026-01-01", expires_at: "2026-06-01" }), "2026-06"), true);
eq("★ expires_at が対象月の前月末日 (境界の前) は false", isAddonActiveInMonth(addon({ applied_from: "2026-01-01", expires_at: "2026-05-31" }), "2026-06"), false);

// ── 年またぎ・月末日計算 (new Date(y, m, 0) の境界) ─────────────────────
eq("★ 12月分の月末は31日 (年またぎの月末計算)", isAddonActiveInMonth(addon({ applied_from: "2026-12-31" }), "2026-12"), true);
eq("★ 翌年1月1日は12月分に含まれない", isAddonActiveInMonth(addon({ applied_from: "2027-01-01" }), "2026-12"), false);
eq("★ 2月分の月末は28日 (平年、うるう年ではない2026年)", isAddonActiveInMonth(addon({ applied_from: "2026-02-28" }), "2026-02"), true);
eq("★ 2月29日は平年には存在しない扱いになる (2026年2月は28日まで)", isAddonActiveInMonth(addon({ applied_from: "2026-03-01" }), "2026-02"), false);
eq("1月分の月初 (前年12月扱いにならないか)", isAddonActiveInMonth(addon({ applied_from: "2026-01-01" }), "2026-01"), true);

// ── 両方が期間外 ─────────────────────────────────────────────────────────
eq("開始も終了も対象月より前 (既に終了済み) は false", isAddonActiveInMonth(addon({ applied_from: "2026-01-01", expires_at: "2026-03-31" }), "2026-06"), false);
eq("開始が対象月より後 (未来の加算) は false", isAddonActiveInMonth(addon({ applied_from: "2026-08-01" }), "2026-06"), false);

// ── getUnitPriceByArea ───────────────────────────────────────────────────
eq("1級地", getUnitPriceByArea("1級地"), 11.40);
eq("7級地", getUnitPriceByArea("7級地"), 10.21);
eq("その他 (地域区分なし)", getUnitPriceByArea("その他"), 10.00);
eq("★ null は その他 にフォールバック", getUnitPriceByArea(null), 10.00);
eq("★ undefined は その他 にフォールバック", getUnitPriceByArea(undefined), 10.00);
eq("★ 空文字は その他 にフォールバック (falsy)", getUnitPriceByArea(""), 10.00);
eq("★ 未知の文字列 (テーブルに無い級地) は その他 にフォールバック (推測しない)", getUnitPriceByArea("8級地"), 10.00);
eq("AREA_UNIT_PRICE_TABLE は 8区分 (1〜7級地+その他)", Object.keys(AREA_UNIT_PRICE_TABLE).length, 8);

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① 境界を間違えた実装 (applied_from の比較を >= ではなく > にする)
  const brokenActive = (a: { status: string; applied_from: string; expires_at: string | null }, billingMonth: string): boolean => {
    if (a.status !== "active") return false;
    const [y, m] = billingMonth.split("-").map(Number);
    const monthEnd = new Date(y, m, 0);
    const appliedFrom = new Date(a.applied_from + "T00:00:00");
    if (appliedFrom >= monthEnd) return false; // ★ わざと >= にする (正は >)
    return true;
  };
  const target = addon({ applied_from: "2026-06-30" }); // 月末ちょうど
  const correct = isAddonActiveInMonth(target, "2026-06");
  const broken = brokenActive(target, "2026-06");
  const detected1 = correct !== broken;
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: applied_from境界の違いを検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ applied_from の境界を1日ずらすバグを検出できる (正=${correct} / 壊れた版=${broken})`);

  // ② フォールバックせず undefined を返す壊れた実装
  const brokenPrice = (area: string | null | undefined): number | undefined => AREA_UNIT_PRICE_TABLE[area ?? ""]; // ★ フォールバック無し
  const correctPrice = getUnitPriceByArea("8級地");
  const brokenPriceVal = brokenPrice("8級地");
  const detected2 = correctPrice !== brokenPriceVal;
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: フォールバックの有無を検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ フォールバックしないバグを検出できる (正=${correctPrice} / 壊れた版=${brokenPriceVal})`);
}

console.log(`\n居宅加算の月次有効判定・地域単価解決 の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
