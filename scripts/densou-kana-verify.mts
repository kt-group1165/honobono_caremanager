/**
 * 国保連伝送ファイル用の半角カナ変換 (densou-kana.ts) の検証 (DB 不使用)
 *
 *   npx tsx scripts/densou-kana-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   ファイル冒頭コメント: 全銀 (fb-zengin.ts の toHankakuKana) とは仕様が
 *   違う。全銀は小書き文字を使えないので大書きに寄せるが、伝送の氏名カナは
 *   小書きをそのまま出す (ほのぼの実例「ｺﾊﾞﾔｼｼﾞｭﾝｺ」)。全銀用を流用すると
 *   拗音・促音が崩れる、という★実際に起きうる取り違えを防ぐための唯一の
 *   差別化点なので、そこを明示的に検証する。fb-zengin側は既に
 *   fb-zengin-verify.mts でテストされているが、densou側は1つも無かった。
 */
import { toDensouKana } from "@/lib/densou-kana";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

// ── 基本のカタカナ→半角カナ ───────────────────────────────────────────────
eq("清音の変換", toDensouKana("アイウエオ"), "ｱｲｳｴｵ");
eq("★ 濁音は2文字 (半角カナ+濁点) になる", toDensouKana("ガギグゲゴ"), "ｶﾞｷﾞｸﾞｹﾞｺﾞ");
eq("半濁音", toDensouKana("パピプペポ"), "ﾊﾟﾋﾟﾌﾟﾍﾟﾎﾟ");
eq("ヴ の変換", toDensouKana("ヴ"), "ｳﾞ");
eq("ー (長音) の変換", toDensouKana("アー"), "ｱｰ");

// ── ★ 小書き文字 (全銀との唯一の差別化点) ──────────────────────────────
eq("★ 小書きのゃゅょ は小書きのまま半角化する (全銀のように大書きにしない)", toDensouKana("ジュンコ"), "ｼﾞｭﾝｺ");
eq("★ 促音っ も小書きのまま", toDensouKana("ニッタ"), "ﾆｯﾀ");
eq("★ 実例: ほのぼの実出力「ｺﾊﾞﾔｼｼﾞｭﾝｺ」(小林純子) と一致する", toDensouKana("コバヤシジュンコ"), "ｺﾊﾞﾔｼｼﾞｭﾝｺ");
eq("★ 実例: ほのぼの実出力「ﾆｯﾀﾕｳﾅ」(新田優奈) と一致する", toDensouKana("ニッタユウナ"), "ﾆｯﾀﾕｳﾅ");
eq("拗音ぁぃぅぇぉ も小書きのまま", toDensouKana("ァィゥェォ"), "ｧｨｩｪｫ");

// ── ひらがな → カタカナ → 半角カナ ────────────────────────────────────────
eq("★ ひらがなはカタカナに寄せてから半角化する", toDensouKana("あいうえお"), "ｱｲｳｴｵ");
eq("ひらがなの濁音も同様", toDensouKana("がぎぐげご"), "ｶﾞｷﾞｸﾞｹﾞｺﾞ");
eq("ひらがなの小書きも小書きのまま", toDensouKana("じゅんこ"), "ｼﾞｭﾝｺ");

// ── 全角英数字 → 半角 ──────────────────────────────────────────────────────
eq("全角数字は半角化する", toDensouKana("１２３"), "123");
eq("全角英字は半角化する", toDensouKana("ＡＢＣ"), "ABC");

// ── 記号 ──────────────────────────────────────────────────────────────────
eq("中黒は半角化する", toDensouKana("・"), "･");
eq("全角スペースは半角スペースになる", toDensouKana("　"), " ");
eq("読点・句点も半角化する", toDensouKana("、。"), "､｡");

// ── 既に半角 / ASCII はそのまま ────────────────────────────────────────────
eq("半角カナはそのまま", toDensouKana("ｶﾀｶﾅ"), "ｶﾀｶﾅ");
eq("半角英数字はそのまま", toDensouKana("ABC123"), "ABC123");

// ── ★ 漢字等は落とす (カナ項目のため) ──────────────────────────────────────
eq("★ 漢字は落とされる (カナ項目なので変換対象にならない)", toDensouKana("小林純子"), "");
eq("★ 漢字とカナが混在していれば漢字だけ落ちる", toDensouKana("小林ジュンコ"), "ｼﾞｭﾝｺ");

// ── 入力異常系 ────────────────────────────────────────────────────────────
eq("null は空文字", toDensouKana(null), "");
eq("undefined は空文字", toDensouKana(undefined), "");
eq("空文字は空文字", toDensouKana(""), "");

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① 全銀用 (小書きを大書きに寄せる) を誤って流用する壊れた実装
  const brokenToHankakuKana = (s: string): string => {
    // ★ 小書きを大書きにマップする全銀方式を誤って適用した想定
    const bigify: Record<string, string> = { ｬ: "ﾔ", ｭ: "ﾕ", ｮ: "ﾖ", ｯ: "ﾂ", ｧ: "ｱ", ｨ: "ｲ", ｩ: "ｳ", ｪ: "ｴ", ｫ: "ｵ" };
    let out = "";
    for (const ch of toDensouKana(s)) out += bigify[ch] ?? ch;
    return out;
  };
  const correct = toDensouKana("ジュンコ");
  const broken = brokenToHankakuKana("ジュンコ");
  const detected1 = correct !== broken;
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: 小書き/大書きの違いを検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ 全銀方式(小書きを大書きに寄せる)を誤って流用するバグを検出できる (正=${correct} / 壊れた版=${broken})`);

  // ② 濁点を分離しない(濁音を1文字のまま出力しようとする)壊れた実装
  const correct2 = toDensouKana("ガ");
  const broken2 = "ｶ"; // ★ 濁点を落として清音だけ出す壊れた版
  const detected2 = correct2 !== broken2;
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: 濁点の脱落を検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ 濁音の濁点を落とすバグを検出できる (正=${correct2} / 壊れた版=${broken2})`);
}

console.log(`\n国保連伝送 半角カナ変換 (densou-kana.ts) の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
