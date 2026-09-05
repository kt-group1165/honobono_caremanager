/**
 * 支給量内訳キーの正規化 (migrations/_shikyuryo_keys.mjs) の検証 (DB 不使用)
 *
 *   npx tsx scripts/shikyuryo-keys-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   _shikyuryo_keys.mjs のコメントに「正は shougai-cert-content.tsx の
 *   SHIKYURYO_ITEMS。増やすときは両方直すこと (.mjs から .ts は import
 *   できない)」とある。これも record-markers.ts と同じ「同じ規約を2箇所で
 *   別々に持つ」型。実際に過去 574 件のバグ (キーが揃わず支給量欄が空・
 *   超過警告が出ない) を踏んでいる (2026-08-19)。
 *
 *   ★ 今回の突き合わせで新たに判明: TS 側 SHIKYURYO_ITEMS は 13 キーだが、
 *   .mjs 側 SHIKYURYO_KEY_MAP の正規キー (値) 集合には "juudo_houkatsu"
 *   (重度障害者等包括支援) が無い。実データ (2026-09-05 実測) では該当
 *   利用者が 0 件で実害は無いが、この制度の利用者が今後入ると
 *   normalizeShikyuryo が unknown 扱いにする (握りつぶさない設計ではあるが
 *   支給量超過チェックからは漏れる)。この検査で継続的に気づけるようにする。
 */
import { readFileSync } from "node:fs";
import { normalizeShikyuryo, SHIKYURYO_KEYS } from "../migrations/_shikyuryo_keys.mjs";

let pass = 0;
const fails: string[] = [];
const warns: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

// ── ★ TS (正) と .mjs (対応表) の正規キー集合の突き合わせ ────────────────
{
  const tsPath = new URL("../src/app/(authenticated)/users/[id]/shougai-cert/shougai-cert-content.tsx", import.meta.url);
  const src = readFileSync(tsPath, "utf8");
  const m = /const SHIKYURYO_ITEMS = \[([\s\S]*?)\] as const;/.exec(src);
  if (!m) {
    fails.push("★ SHIKYURYO_ITEMS の定義が見つからない (TS側の構造が変わった可能性)");
  } else {
    const tsKeys = [...m[1].matchAll(/key:\s*"([a-z0-9_]+)"/g)].map((x) => x[1]);
    eq("★ TS側 SHIKYURYO_ITEMS からキーが抽出できる (13キー以上)", tsKeys.length >= 13, true);
    const mjsKeys = SHIKYURYO_KEYS as Set<string>;
    const onlyInTs = tsKeys.filter((k) => !mjsKeys.has(k));
    const onlyInMjs = [...mjsKeys].filter((k) => !tsKeys.includes(k));
    // ★ 既知のギャップ (2026-09-05 実測で実害0件と確認済み)。新たな不一致が
    //   増えたらここに追加せず FAIL させる (見張りとして機能させる)
    const KNOWN_GAP = ["juudo_houkatsu"];
    const unexpectedOnlyInTs = onlyInTs.filter((k) => !KNOWN_GAP.includes(k));
    if (unexpectedOnlyInTs.length > 0) {
      fails.push(`★★ TS側にあって.mjs側に無いキー (未知の不一致): ${unexpectedOnlyInTs.join(", ")} — .mjs側の対応表を直すこと`);
    } else {
      pass++;
      console.log(`  ✓ TS→.mjs 片方向の同期 (既知のギャップ ${KNOWN_GAP.join(",")} 以外は一致)`);
    }
    if (onlyInMjs.length > 0) {
      fails.push(`★★ .mjs側にあってTS側に無いキー (削除漏れの疑い): ${onlyInMjs.join(", ")}`);
    } else {
      pass++;
      console.log("  ✓ .mjs→TS 片方向の同期 (余分なキーなし)");
    }
    for (const k of KNOWN_GAP) {
      if (tsKeys.includes(k)) warns.push(`⚠ 既知のギャップ "${k}" (重度障害者等包括支援) はまだ.mjs側に無い。実データ0件で実害なしと確認済み (2026-09-05)`);
    }
  }
}

// ── normalizeShikyuryo: 日本語キー → 正規キー ────────────────────────────
eq("身体介護 → shintai", normalizeShikyuryo({ "身体介護": { hours: 10 } }).details, { shintai: { hours: 10 } });
eq("重度訪問介護区分６該当 (全角６) → juudo_houmon_kubun6", normalizeShikyuryo({ "重度訪問介護区分６該当": { hours: 5 } }).details, { juudo_houmon_kubun6: { hours: 5 } });

// ── ★ 冪等性 (既にローマ字キーならそのまま通す) ──────────────────────────
eq("★ 既にローマ字キー (shintai) はそのまま通る (再実行しても壊れない)", normalizeShikyuryo({ shintai: { hours: 10 } }).details, { shintai: { hours: 10 } });

// ── unknown キー (対応表に無い) は握りつぶさず返す ───────────────────────
eq("★ 未知のキーは details に入れず unknown で返す", normalizeShikyuryo({ "存在しない項目": { hours: 1 } }), { details: null, unknown: ["存在しない項目"] });
eq("既知キーと未知キーが混在しても両方処理される (details)", normalizeShikyuryo({ "身体介護": { hours: 1 }, "謎の項目": { hours: 2 } }).details, { shintai: { hours: 1 } });
eq("既知キーと未知キーが混在しても両方処理される (unknown)", normalizeShikyuryo({ "身体介護": { hours: 1 }, "謎の項目": { hours: 2 } }).unknown, ["謎の項目"]);

// ── ★ 同じ正規キーへの表記ゆれが複数来たら値の大きいほうを残す ───────────
eq("★ 表記ゆれ2件 (時間の大きい方を残す)", normalizeShikyuryo({ "身体介護": { hours: 5 }, "shintai": { hours: 10 } }).details, { shintai: { hours: 10 } });
eq("★ 先に大きい値が来ても負けない (順序に依存しない)", normalizeShikyuryo({ "shintai": { hours: 10 }, "身体介護": { hours: 5 } }).details, { shintai: { hours: 10 } });
eq("count種別の比較でも大きい方が残る", normalizeShikyuryo({ "乗降介助": { count: 3 }, "jouko": { count: 8 } }).details, { jouko: { count: 8 } });

// ── 入力の型異常 ─────────────────────────────────────────────────────────
eq("null 入力は details=null, unknown=[]", normalizeShikyuryo(null), { details: null, unknown: [] });
eq("undefined 入力は details=null, unknown=[]", normalizeShikyuryo(undefined), { details: null, unknown: [] });
eq("非オブジェクト (文字列) 入力は details=null, unknown=[]", normalizeShikyuryo("invalid"), { details: null, unknown: [] });
eq("空オブジェクトは details=null (Object.keysが0)", normalizeShikyuryo({}).details, null);

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① unknown を握りつぶす壊れた実装 (対応表に無いキーを黙って捨てる)
  const brokenSwallow = (q: Record<string, unknown>): Record<string, unknown> => {
    const details: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(q)) {
      const key = (SHIKYURYO_KEYS as Set<string>).has(k) ? k : null;
      if (key) details[key] = v; // ★ 未知キーは黙って捨てる (unknown を返さない)
    }
    return details;
  };
  const input = { "謎の項目": { hours: 1 } };
  const correct = normalizeShikyuryo(input).unknown.length;
  const broken = Object.keys(brokenSwallow(input)).length; // 常に0 (unknownの概念が無い)
  const detected1 = correct > 0 && broken === 0;
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: unknown握りつぶしの違いを検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ unknownを握りつぶす(気づけなくする)バグを検出できる (正=unknown ${correct}件 / 壊れた版=0件で気づけない)`);

  // ② 表記ゆれの統合で「後着優先」にする壊れた実装 (正は値の大きい方)
  const brokenLastWins = (a: { hours: number }, b: { hours: number }) => b; // ★ 単純に後の値で上書き
  const merged = normalizeShikyuryo({ "身体介護": { hours: 10 }, "shintai": { hours: 5 } }).details;
  const brokenResult = brokenLastWins({ hours: 10 }, { hours: 5 });
  const detected2 = JSON.stringify(merged) !== JSON.stringify({ shintai: brokenResult });
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: マージ規則(大きい方 vs 後着優先)の違いを検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ 後着優先にする(値が小さい方で上書きされうる)バグを検出できる (正=${JSON.stringify(merged)} / 壊れた版=shintai:${JSON.stringify(brokenResult)})`);
}

console.log(`\n支給量内訳キーの正規化 の検証 — ${pass + fails.length} 件`);
for (const w of warns) console.log(`  ${w}`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
