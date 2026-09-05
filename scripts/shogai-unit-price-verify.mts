/**
 * 障害福祉サービスの地域区分単価 (getShogaiHomonUnitPrice) の検証 (DB 不使用)
 *
 *   npx tsx scripts/shogai-unit-price-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   ファイル冒頭に「実伝送3事業所で検証済み (2026-07-31)」とあるが、それは
 *   実データ突合の記録であって、この純関数自体の単体テストは無かった。
 *   介護の単価をそのまま使うと人件費割合の違いで単価がズレる、という
 *   注意書きがあるほど間違えやすい計算なので、境界を先に固定する。
 *
 *   規則 (ソースのコメント通り):
 *     単価 = 10 × (1 + 級地上乗せ率 × 0.6) を 0.01円単位で丸める
 *     未知の級地 / null / undefined は「その他」(上乗せ率0 → 10.00円) にフォールバック
 */
import { getShogaiHomonUnitPrice, SHOGAI_AREA_CATEGORIES } from "@/lib/shogai-seikyu/unit-price";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

// ── 実伝送で検証済みの3点 (ファイル冒頭コメントの実測値) ─────────────────
eq("★ 5級地 (市原市) = 10.60 (実伝送で検証済み)", getShogaiHomonUnitPrice("5級地"), 10.60);
eq("★ 6級地 (茂原市) = 10.36 (実伝送で検証済み)", getShogaiHomonUnitPrice("6級地"), 10.36);
eq("★ 7級地 (大網白里市) = 10.18 (実伝送で検証済み)", getShogaiHomonUnitPrice("7級地"), 10.18);

// ── 全級地を計算式どおりに ────────────────────────────────────────────
eq("1級地 = 10×(1+0.20×0.6) = 11.20", getShogaiHomonUnitPrice("1級地"), 11.20);
eq("2級地 = 10×(1+0.16×0.6) = 10.96", getShogaiHomonUnitPrice("2級地"), 10.96);
eq("3級地 = 10×(1+0.15×0.6) = 10.90", getShogaiHomonUnitPrice("3級地"), 10.90);
eq("4級地 = 10×(1+0.12×0.6) = 10.72", getShogaiHomonUnitPrice("4級地"), 10.72);
eq("その他 = 10×(1+0×0.6) = 10.00", getShogaiHomonUnitPrice("その他"), 10.00);

// ── フォールバック (推測せず「その他」= 10.00円に倒す) ──────────────────
eq("★ null は その他(10.00円) にフォールバック", getShogaiHomonUnitPrice(null), 10.00);
eq("★ undefined は その他(10.00円) にフォールバック", getShogaiHomonUnitPrice(undefined), 10.00);
eq("★ 未知の文字列 (8級地など存在しない級地) は その他 にフォールバック", getShogaiHomonUnitPrice("8級地"), 10.00);
eq("空文字は その他 にフォールバック", getShogaiHomonUnitPrice(""), 10.00);
eq("★ 前後の空白は trim される", getShogaiHomonUnitPrice(" 7級地 "), 10.18);

// ── 介護保険の単価と混同していないか (人件費割合60% vs 70%の違い) ───────
{
  // 介護 7級地 (人件費割合70%): 10×(1+0.03×0.70)=10.21 (claims-shared.ts の AREA_UNIT_PRICE_TABLE)
  // 障害 7級地 (人件費割合60%): 10×(1+0.03×0.60)=10.18 (このモジュール)
  // ⚠ ソースコメントの上乗せ率 (0.03) は claims-shared.ts の AREA_UNIT_PRICE_TABLE 側の
  //   古い上乗せ率の例であって、このモジュール自身の AREA_SURCHARGE (7級地=0.03) とは
  //   別物ではなく実際に同じ値 (0.03) を使っている。念のため一致を確認する。
  const kaigo7 = 10 * (1 + 0.03 * 0.70);
  const shogai7 = getShogaiHomonUnitPrice("7級地");
  eq("★ 障害と介護で7級地の単価が違う (混同していない)", shogai7 === Math.round(kaigo7 * 100) / 100, false);
  eq("障害7級地は 10.18 (介護の 10.21 とは別値)", shogai7, 10.18);
}

// ── 級地一覧 (設定画面の選択肢) ──────────────────────────────────────────
eq("SHOGAI_AREA_CATEGORIES は 8区分 (1〜7級地+その他)", SHOGAI_AREA_CATEGORIES.length, 8);
eq("SHOGAI_AREA_CATEGORIES に その他 が含まれる", SHOGAI_AREA_CATEGORIES.includes("その他"), true);

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① 介護の人件費割合(0.70)を誤って使う壊れた実装 (障害は0.60が正しい)
  const brokenPrice = (area: string): number => {
    const surcharge: Record<string, number> = { "7級地": 0.03 };
    return Math.round(10 * (1 + (surcharge[area] ?? 0) * 0.70) * 100) / 100; // ★ わざと 0.70 (介護の割合)
  };
  const correct = getShogaiHomonUnitPrice("7級地");
  const broken = brokenPrice("7級地");
  const detected1 = correct !== broken;
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: 人件費割合の取り違えを検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ 人件費割合を介護用(0.70)に取り違えるバグを検出できる (正=${correct} / 壊れた版=${broken})`);

  // ② trim を省略する壊れた実装 (末尾の note にある「前後の空白は trim される」を裏取り)
  const brokenNoTrim = (area: string): number => {
    const AREA_SURCHARGE: Record<string, number> = { "7級地": 0.03 };
    return Math.round(10 * (1 + (AREA_SURCHARGE[area] ?? 0) * 0.6) * 100) / 100; // ★ trim しない
  };
  const correct2 = getShogaiHomonUnitPrice(" 7級地 ");
  const broken2 = brokenNoTrim(" 7級地 "); // key に前後スペースが残るので AREA_SURCHARGE にヒットせず 10.00 になる
  const detected2 = correct2 !== broken2;
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: trim の有無を検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ trim しないバグを検出できる (正=${correct2} / 壊れた版=${broken2})`);

  // ★ 全級地で丸め誤差が実際には生じない (10×上乗せ率×0.6 がすべて割り切れる値) ことを記録として残す。
  //   丸め処理そのものの負のコントロールは意味を成さないため、trim の方で境界を確保する。
  console.log("  (参考) 全級地とも Math.round の有無で値が変わらない (10×上乗せ率×0.6 が割り切れる値のため)");
}

console.log(`\n障害福祉 地域区分単価 の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
