/**
 * サービス名→略称 (service-short-name.ts) の検証 (DB 不使用)
 *
 *   npx tsx scripts/service-short-name-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   ファイル冒頭コメント: 「DB (kaigo_service_codes.short_name) と同じルール
 *   (migrations/seed_service_codes_short_name.mjs) をTS化したもの」。
 *   .mjs から TS を import できないため逐語コピーになっており
 *   (VERIFICATION_RULES.md 7-1b/3-14と同型)、1つも検証されていなかった。
 *
 *   ★ 実際に3箇所の乖離を発見した (.mjs を readFileSync で読んで比較。
 *   .mjs 自体はトップレベルで env 変数チェック→process.exit(1) するため
 *   import できず、該当ルールをこのファイルに書き写して比較している):
 *
 *   ① 身体介護X・生活Y の複合ルールで、2つ目の数字(生活側)の全角/半角が違う。
 *      TS「身1生1」(両方半角) / .mjs「身1生１」(2つ目だけ全角に戻す)。
 *      TSのファイル冒頭コメント例が「身1生1」なので、.mjs側の
 *      asciiToZenkaku二度掛けが意図せぬバグの可能性が高いが、判断は
 *      ここでは行わず「食い違いがある」ことだけを固定化して報告する。
 *   ② TSには「訪問介護相当サービス」「通所介護相当サービス」が総合事業の
 *      A類型ルールに含まれるが、.mjs には無い (総訪A/総通Aにならず
 *      別ルールかfallbackに落ちる)。
 *   ③ 未マッチ時のfallback長: TSは3文字、.mjsは2文字。
 *
 *   これらは money-impact が無い表示上の差 (カレンダーセルの略称) だが、
 *   「同じ規則のはず」が実際には違うという構造的リスクの実例として記録する。
 */
import { serviceShortName } from "@/lib/service-short-name";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

// ── 基本ルール (ファイル冒頭コメントの例と一致) ────────────────────────────
eq("身体介護3 → 身3", serviceShortName("身体介護3"), "身3");
eq("★ 全角数字・接尾語混在でも数字部分だけ抽出する", serviceShortName("身体介護０１・２人・夜"), "身01");
eq("生活援助2 → 生2", serviceShortName("生活援助2"), "生2");
eq("★ 複合ルール (身体+生活) が単純身体ルールより先に評価される", serviceShortName("身体介護1・生活1"), "身1生1");
eq("訪問型独自サービス11 → 総訪A", serviceShortName("訪問型独自サービス11"), "総訪A");

// ── ルール優先順位 (より特殊なパターンが先) ────────────────────────────────
eq("通院等乗降介助は「乗」(通院等介助の「通」ではない)", serviceShortName("通院等乗降介助"), "乗");
eq("通院等介助(乗降なし)は「通」", serviceShortName("通院等介助"), "通");
eq("身体介護 (数字なし) は「身」", serviceShortName("身体介護"), "身");

// ── 介護予防の可変ルール ───────────────────────────────────────────────────
eq("★ 介護予防+2文字 → 予+その2文字", serviceShortName("介護予防通所リハビリテーション"), "予通所");
eq("介護予防のみ (後続なし) → 予", serviceShortName("介護予防"), "予");

// ── 障害福祉・総合事業の代表例 ──────────────────────────────────────────────
eq("重度訪問介護 → 重訪", serviceShortName("重度訪問介護"), "重訪");
eq("居宅介護 (障害) → 居宅", serviceShortName("居宅介護"), "居宅");
eq("★ 居宅介護支援 (居宅介護とは別ルール、より特殊) は「居ケ」", serviceShortName("居宅介護支援"), "居ケ");
eq("就労継続支援A型 → 就A", serviceShortName("就労継続支援A型"), "就A");
eq("就労継続支援B型 → 就B", serviceShortName("就労継続支援B型"), "就B");

// ── フォールバック (どのルールにもマッチしない) ────────────────────────────
eq("★ 未マッチは先頭3文字 (TS側の規則)", serviceShortName("謎のサービス名称"), "謎のサ");
eq("空文字は「—」", serviceShortName(""), "—");
eq("空白のみは「—」", serviceShortName("   "), "—");
eq("null は「—」", serviceShortName(null), "—");
eq("undefined は「—」", serviceShortName(undefined), "—");
eq("前後の空白はtrimして判定する", serviceShortName("  身体介護1  "), "身1");

// ── ★ .mjs (migrations/seed_service_codes_short_name.mjs) との既知の乖離 ───
// .mjs はトップレベルで env チェック→process.exit(1) するため import できない。
// 該当ルールをここに書き写して比較する (7-1b: importできない場所のロジック)。
{
  const Z2A: Record<string, string> = { "０": "0", "１": "1", "２": "2", "３": "3", "４": "4", "５": "5", "６": "6", "７": "7", "８": "8", "９": "9" };
  const zenkakuToAscii = (s: string) => s.replace(/[０-９]/g, (ch) => Z2A[ch] ?? ch);
  const A2Z: Record<string, string> = { "0": "０", "1": "１", "2": "２", "3": "３", "4": "４", "5": "５", "6": "６", "7": "７", "8": "８", "9": "９" };
  const asciiToZenkaku = (s: string) => s.replace(/[0-9]/g, (ch) => A2Z[ch] ?? ch);

  // ① 複合ルールの2つ目の数字の全角/半角
  const mjsComboOutput = (m1: string, m2: string) => `身${zenkakuToAscii(m1)}生${asciiToZenkaku(zenkakuToAscii(m2))}`;
  const mjsResult = mjsComboOutput("1", "1");
  const tsResult = serviceShortName("身体介護1・生活1");
  eq("★★ 既知の乖離①: 複合ルールの2つ目の数字が TS(半角)と.mjs(全角に戻す)で違う", tsResult === mjsResult, false);
  console.log(`     TS=${tsResult} / .mjs書き写し=${mjsResult} (一致しないことを確認済み。要判断: どちらが正か)`);

  // ② 「訪問介護相当サービス」「通所介護相当サービス」は.mjsのルールに存在しない
  //    (.mjsのRULESにこの2パターンが含まれないため、総合事業A類型にならない)
  const mjsHasVisitEquivalentRule = /^訪問型独自サービス|^訪問型サービスA/.test("訪問介護相当サービス1");
  const tsResult2 = serviceShortName("訪問介護相当サービス1");
  eq("★★ 既知の乖離②: 「訪問介護相当サービス」はTSでは総訪Aになるが.mjsのルールには該当パターンが無い", [tsResult2, mjsHasVisitEquivalentRule], ["総訪A", false]);

  // ③ フォールバックの長さ (TS=3文字 / .mjs=2文字)
  const tsFallback = serviceShortName("謎のサービス名称");
  const mjsFallback = "謎のサービス名称".slice(0, 2);
  eq("★★ 既知の乖離③: 未マッチ時のfallback長がTS(3文字)と.mjs(2文字)で違う", tsFallback.length === mjsFallback.length, false);
  console.log(`     TS=${tsFallback} (${tsFallback.length}文字) / .mjs=${mjsFallback} (${mjsFallback.length}文字)`);
}

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① 複合ルールを単純身体ルールより後に評価する壊れた実装 (先着ルールが誤って勝つ)
  const brokenOrder = (name: string): string => {
    // ★ ルール順序を入れ替える (単純身体を先に評価してしまう)
    const m1 = name.match(/^身体介護([0-9]+)/);
    if (m1) return `身${m1[1]}`; // 複合の「・生活Y」部分に気づかず単純ルールで止まる
    return name.slice(0, 3);
  };
  const correct = serviceShortName("身体介護1・生活1");
  const broken = brokenOrder("身体介護1・生活1");
  const detected1 = correct !== broken;
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: ルール優先順序の違いを検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ 複合ルールを単純身体ルールより後回しにする(優先順序間違い)バグを検出できる (正=${correct} / 壊れた版=${broken})`);

  // ② フォールバックを1文字にする壊れた実装
  const correct2 = serviceShortName("謎のサービス名称");
  const broken2 = "謎のサービス名称".slice(0, 1);
  const detected2 = correct2 !== broken2;
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: fallback長の違いを検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ fallbackを1文字にするバグを検出できる (正=${correct2} / 壊れた版=${broken2})`);
}

console.log(`\nサービス名→略称 (service-short-name.ts) の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み。★★は既知の乖離を記録するテストで、値の食い違い自体がPASS条件)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
