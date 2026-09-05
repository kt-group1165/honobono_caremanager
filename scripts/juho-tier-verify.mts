/**
 * 重度訪問介護の「段」判定 (juho-tier.ts) の純関数部分の検証 (DB 不使用)
 *
 *   npx tsx scripts/juho-tier-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   段 (サービス費Ⅰ/Ⅱ/Ⅲ) は市町村の支給決定で決まり、事業所が選べない。
 *   誤って別の段を算定すると単位数が変わる (2026-08-19 実例: 14名中7名が
 *   Ⅰなのに全員Ⅱで登録され過少請求)。
 *
 *   `splitTier` のコメントに「⚠ NFKC だと「Ⅱ」が "II" に分解されて
 *   一致しなくなる。NFC を使うこと」とあるが、この境界を固定する検証が
 *   無かった (splitTier は非export だったため呼べなかった。今回 export した
 *   ★ 挙動は変えていない — export キーワードを足しただけ)。
 */
import { splitTier, remapJuhoCode, isJuhoTierCode, type JuhoTierMaps, type JuhoCode } from "@/lib/shogai-seikyu/juho-tier";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

// ── splitTier: 段と素の名前の切り出し ────────────────────────────────────
eq("重訪Ⅰ日中８．０ → Ⅰ / 日中８．０", splitTier("重訪Ⅰ日中８．０"), { tier: "Ⅰ", base: "日中８．０" });
eq("重訪Ⅱ深夜０．５ → Ⅱ / 深夜０．５", splitTier("重訪Ⅱ深夜０．５"), { tier: "Ⅱ", base: "深夜０．５" });
eq("重訪Ⅲ・２人 → Ⅲ / ・２人", splitTier("重訪Ⅲ・２人"), { tier: "Ⅲ", base: "・２人" });
eq("★ base が空文字でも切り出せる (重訪Ⅱだけ)", splitTier("重訪Ⅱ"), { tier: "Ⅱ", base: "" });
eq("「重訪」で始まらない名前は null", splitTier("移動介護加算"), null);
eq("★ 段の文字 (Ⅰ/Ⅱ/Ⅲ) が続かない「重訪」だけは null (段なしコード)", splitTier("重訪移動介護加算"), null);
eq("空文字は null", splitTier(""), null);

// ── ★ NFC/NFKC 正規化の境界 (コメントの注意書きを裏取り) ────────────────
{
  // 半角ローマ数字 "II" (NFKC で「Ⅱ」を分解した結果と同じ文字列) は マッチしないはず
  const withRoman = splitTier("重訪II日中８．０");
  eq("★ 半角ローマ数字 (NFKC分解後の形) では マッチしない = 正規表現は全角Ⅰ Ⅱ Ⅲ 前提", withRoman, null);

  // NFKC 正規化してから渡すとどうなるかを明示的に確認 (関数自身は NFC 前提)
  const nfkcInput = "重訪Ⅱ日中８．０".normalize("NFKC"); // → "重訪II日中8.0" になる
  const afterNfkc = splitTier(nfkcInput);
  eq("★ 呼び出し側が誤って NFKC 正規化して渡すと マッチしなくなる (実害の再現)", afterNfkc, null);

  // 全角のまま (NFC) なら正しくマッチする
  const nfcInput = "重訪Ⅱ日中８．０".normalize("NFC");
  const afterNfc = splitTier(nfcInput);
  eq("NFC のまま渡せば正しくマッチする", afterNfc?.tier, "Ⅱ");
}

// ── remapJuhoCode / isJuhoTierCode (JuhoTierMaps を手動構築) ────────────
function mkMaps(entries: { base: string; tier: "Ⅰ" | "Ⅱ" | "Ⅲ"; code: string; units: number }[]): JuhoTierMaps {
  const byBase = new Map<string, Partial<Record<"Ⅰ" | "Ⅱ" | "Ⅲ", JuhoCode>>>();
  const byCode = new Map<string, { base: string; tier: "Ⅰ" | "Ⅱ" | "Ⅲ" }>();
  for (const e of entries) {
    byCode.set(e.code, { base: e.base, tier: e.tier });
    const slot = byBase.get(e.base) ?? {};
    slot[e.tier] = { code: e.code, name: `重訪${e.tier}${e.base}`, units: e.units };
    byBase.set(e.base, slot);
  }
  return { byBase, byCode };
}

{
  const maps = mkMaps([
    { base: "日中８．０", tier: "Ⅰ", code: "121121", units: 98 },
    { base: "日中８．０", tier: "Ⅱ", code: "121221", units: 92 },
    { base: "日中８．０", tier: "Ⅲ", code: "121321", units: 85 },
  ]);
  eq("★ Ⅱのコードを Ⅰ に読み替えると 98単位のコードが返る", remapJuhoCode(maps, "121221", "Ⅰ")?.code, "121121");
  eq("読み替え先が単位数まで正しい", remapJuhoCode(maps, "121221", "Ⅰ")?.units, 98);
  eq("同じ段に読み替えると同じコードが返る", remapJuhoCode(maps, "121221", "Ⅱ")?.code, "121221");
  eq("★ 段付きコードではない (移動介護加算等) は null", remapJuhoCode(maps, "999999", "Ⅰ"), null);
  eq("★ 読み替え先の段がマスタに無ければ null (推測しない)", remapJuhoCode(mkMaps([{ base: "日中１．０", tier: "Ⅱ", code: "X", units: 10 }]), "X", "Ⅰ"), null);

  eq("isJuhoTierCode: 段付きコードは true", isJuhoTierCode(maps, "121121"), true);
  eq("isJuhoTierCode: 段付きでないコードは false", isJuhoTierCode(maps, "999999"), false);
  eq("isJuhoTierCode: null/undefined は false", isJuhoTierCode(maps, null), false);
  eq("isJuhoTierCode: undefined は false", isJuhoTierCode(maps, undefined), false);
}

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① NFKC 正規化してしまう壊れた実装 (コメントが警告している事故そのもの)
  const brokenSplitTier = (name: string): { tier: string; base: string } | null => {
    const m = /^重訪(Ⅰ|Ⅱ|Ⅲ)(.*)$/.exec((name ?? "").normalize("NFKC")); // ★ わざと NFKC
    return m ? { tier: m[1], base: m[2] } : null;
  };
  const correct = splitTier("重訪Ⅱ日中８．０");
  const broken = brokenSplitTier("重訪Ⅱ日中８．０");
  const detected1 = correct !== null && broken === null;
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: NFC/NFKCの違いを検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ NFKC正規化してしまうバグを検出できる (正=${JSON.stringify(correct)} / 壊れた版=${JSON.stringify(broken)})`);

  // ② 段の読み替えを「同じbaseなら何でもいい」で選ぶ壊れた実装 (段を無視する)
  const maps = mkMaps([
    { base: "日中８．０", tier: "Ⅰ", code: "121121", units: 98 },
    { base: "日中８．０", tier: "Ⅱ", code: "121221", units: 92 },
  ]);
  const correctRemap = remapJuhoCode(maps, "121221", "Ⅲ"); // Ⅲ が無いので null が正しい
  const brokenRemap = maps.byBase.get("日中８．０")?.Ⅰ; // ★ 段を無視して最初に見つかったものを返す壊れた版
  const detected2 = correctRemap === null && brokenRemap != null;
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: 段を無視する実装との差を検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ 段を無視して別の段のコードを返すバグを検出できる (正=${JSON.stringify(correctRemap)} / 壊れた版=${JSON.stringify(brokenRemap)})`);
}

console.log(`\n重度訪問介護の段判定 (純関数部分) の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
