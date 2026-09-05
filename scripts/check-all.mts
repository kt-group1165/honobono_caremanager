/**
 * ★ 金額に効く検査をまとめて回す (push 前のゲート)
 *
 *   npm run check:all              全部
 *   npm run check:all -- --fast    ★ 遅いもの (伝送突合 約4分) を飛ばす
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   check: が ★ 24 本まで増えて、どれを回せばよいか分からなくなった。
 *   ★ 「金額が変わったら落ちる」ものだけを 1 コマンドにまとめる。
 *
 * ⚠ ★ 「全部緑」は「正しい」ではありません。何を ★ 見ていないかは下の一覧に書きます。
 * ⚠ ここに無い check も価値はあります。★ 落ちても金額が動かないもの (帳票の空欄検査 等) を
 *   外しているだけです。
 */
import { spawnSync } from "node:child_process";

const FAST = process.argv.includes("--fast");

/**
 * kind
 *   "strict"   ★ 0 を目指す。壊れたら (=差が出たら) 落ちる
 *   "baseline" ★ 既知の差・既知のリスク件数を基準値として許容したうえでの PASS。0件PASSではない
 * knownDiff — baseline のとき、現在許容している既知差の件数 (数える単位が同じもののみ設定)。
 */
type Check = { name: string; script: string; why: string; slow?: boolean; kind?: "strict" | "baseline"; knownDiff?: number };

/**
 * ★ 「サンプル未投入で分母0のためPASS(exit 0)」を、出力本文の文言から機械的に検出する。
 * kaigo-app の *-sample-verify.mts / verify-jogen-kanri.mts はこの言い回しの規約に従う。
 * (2026-09-05 claude-06 指摘: PASSの中に「本当にPASS」と「未検証」が混ざって見分けが付かなかった)
 */
const NO_SAMPLE_MARKERS = ["サンプル未投入", "合格とは言わない", "合格でも不合格でもありません"];
function looksLikeNoSampleSkip(out: string): boolean {
  return NO_SAMPLE_MARKERS.some((m) => out.includes(m));
}

/** ★ 落ちたら金額か返戻に効くものだけ */
const CHECKS: Check[] = [
  { name: "smoke", script: "smoke", why: "集計の回帰 (金額)。指紋で「データが変わった」と区別する" },
  { name: "invariant", script: "check:invariant", why: "★ 17条件を 全事業所・4制度に当てる (内部の関係が壊れていないか)" },
  { name: "densou", script: "check:densou", why: "伝送前の事前点検 (返戻・過大請求の元)" },
  { name: "anon", script: "check:anon", why: "★ 個人情報が anon から読めないか (分母は PostgREST の 228 表)" },
  { name: "addon-lines", script: "check:addon-lines", why: "★ 加算行の 書式ずれ (制度で読み方が違う) と マスタ実在" },
  { name: "month-format", script: "check:month-format", why: "★ 月を表す text 列 39 個の 書式ずれ (書く側と読む側で違うと 0 件になる)" },
  // ★ 同じ規約を 2 箇所で別々に持っているもの の見張り。TS から .mjs を import できないため
  //   実績の行種マーカーが TS 側と取込 script 側に 二重定義されている。片方だけ直すと
  //   ★ 請求集計と実績記録票の判定が 黙って食い違う (落ちないので気づけない)。
  { name: "record-markers", script: "check:record-markers", why: "★ 行種マーカーの TS/.mjs 二重定義が ずれていないか" },
  //   ★ 同型。過去に 574 件の実バグ (キーが揃わず支給量欄が空・超過警告が出ない)。
  { name: "shikyuryo-keys", script: "check:shikyuryo-keys", why: "★ 支給量キーの TS/.mjs 二重定義が ずれていないか" },
  // ★ sample seed が「今も起動するか」だけを見る (DRY RUN・DB 書込なし)。
  //   ★ 2026-09-05 に 14 本中 2 本が起動しなくなっていた (_sample_data.mjs の変更に追随漏れ)。
  //   ★ 「検証済み」と文書にあっても 再実行したら動かない、が実在したので gate に置く。
  { name: "sample-seeds", script: "check:sample-seeds", why: "★ サンプル seed 14 本が DRY RUN で起動するか (壊れると検証手段ごと失う)" },
  // ★ 2026-09-05 に積み上がった純関数の検査。★ どれも 落ちたら金額が動く。
  //   ★ 1 本 2 秒程度で DB を使わないので gate に入れて問題ない。
  { name: "shuchu-gensan", script: "check:shuchu-gensan", why: "特定事業所集中減算 (80%/法人)" },
  { name: "kyotaku-addon-active", script: "check:kyotaku-addon-active", why: "居宅加算の月次有効判定・地域単価 (月末/翌月1日の境界)" },
  { name: "shogai-unit-price", script: "check:shogai-unit-price", why: "★ 障害の地域区分単価 (人件費割合 60%。介護の 70% と取り違えやすい)" },
  { name: "juho-tier", script: "check:juho-tier", why: "★ 重度訪問介護の段判定 (NFKC で Ⅱ が壊れる)" },
  { name: "shogai-fukushi-billing", script: "check:shogai-fukushi-billing", why: "障害福祉のコード検索" },
  { name: "same-building", script: "check:same-building", why: "同一建物減算" },
  { name: "seikatsu-enjo", script: "check:seikatsu-enjo", why: "生活援助中心型の回数制限" },
  { name: "visit-addons", script: "check:visit-addons", why: "訪問介護の加算 (116274 混入ガード)" },
  // ★ 2026-09-05 の 45 本仕分け (J) で ★ 「作ったのに 回す入口が無かった」と分かったもののうち、
  //   ★ 金額か返戻に直結する 9 本を編入。★ 全部 実行して EXIT=0 を確認済み。
  { name: "fb-zengin", script: "check:fb-zengin", why: "★ 全銀フォーマット (口座振替。桁・カナが崩れると 引き落とし不能)" },
  { name: "kohi-duplicate", script: "check:kohi-duplicate", why: "★ 公費の重複 (取込のたびに増える。部分公費が来た月に返戻)", slow: true },
  { name: "kohi-tiebreak", script: "check:kohi-tiebreak", why: "公費が複数あるときの採用順" },
  { name: "keikakuhi-8124", script: "check:keikakuhi-8124", why: "居宅介護支援費 8124 の組み立て" },
  { name: "kyufu-kanri-8222", script: "check:kyufu-kanri-8222", why: "給付管理票 8222 の組み立て" },
  { name: "kyufu-kanri-boundary", script: "check:kyufu-kanri-boundary", why: "給付管理票の境界値" },
  { name: "shogai-j11-boundary", script: "check:shogai-j11-boundary", why: "障害 J11 系の境界値" },
  { name: "shogai-j411-boundary", script: "check:shogai-j411-boundary", why: "障害 J411 (上限管理) の境界値" },
  { name: "gendo-allocation", script: "check:gendo-allocation", why: "区分支給限度基準額 超過の割振り (★ 超過単位は 自費金額に直結)" },
  { name: "kyotaku-matrix", script: "check:kyotaku-matrix", why: "居宅介護支援の単位数 (加算・減算・逓減)" },
  { name: "idou-summary", script: "check:idou-summary", why: "移動支援の負担額・上限" },
  { name: "riyou-final", script: "check:riyou-final", why: "利用者請求書の最終額 (軽減・実費・繰越)" },
  { name: "sougou-shoguu", script: "check:sougou-shoguu", why: "総合事業の処遇改善 (自治体独自率)" },
  { name: "shoguu-4impl", script: "check:shoguu-4impl", why: "★ 処遇改善の % 計算が 4 制度の実装で一致するか" },
  { name: "service-code-gap", script: "check:service-code-gap", why: "★ 単位数0・加算率未設定のコードが 実発火しうるか",
    kind: "baseline" }, // 「理論上のみ」の件数は基準値 (0件を目指す検査ではない)。実発火(NG)は0を維持
  { name: "teigen", script: "check:teigen", why: "逓減制" },
  { name: "shogai-jogen", script: "check:shogai-jogen", why: "障害の上限額管理" },
  { name: "tokutei", script: "check:tokutei", why: "特定事業所加算" },
  // ★ 訪問入浴は 実データが 0 行だが、これだけは Supabase をモックする純関数テストなので
  //   ★ DB 書込を伴わない = gate に入れてよい (もう一方の check:bath-sample は
  //   サンプル投入が要るので 意図的に入れていない)。2026-09-05 に編入。
  { name: "bath-fixture", script: "check:bath-fixture", why: "★ 訪問入浴の請求 (DB書込不要のモックテスト。実データは 0 行)" },
  // ★ 2026-09-05 追加。apply.ts は本番コードなのに検証0本だった (parse.ts の fixture テストはあるが
  //   ★ DB反映ロジック=返戻フラグ/支払決定額/冪等性 は未検証)。Supabase を丸ごとモックするので DB書込不要。
  { name: "kokuho-tsuchi", script: "check:kokuho-tsuchi", why: "★ 国保連通知取込の DB 反映 (突合フォールバック・返戻/支払決定の冪等性・金額境界値。モックのみ)" },
  { name: "kyotaku-diff", script: "check:kyotaku-diff", why: "★ 居宅の伝送バイト照合 (ほのぼの実出力との突合。認定更新で差が増えるので 回帰だけ見張る)", slow: true,
    kind: "baseline" }, // 基準値=現状の一致率。認定更新のたび差が動くため0件を目指さない
  { name: "densou-diff", script: "check:densou-diff", why: "★ ほのぼの実出力との突合 (介護保険7拠点 + 障害17拠点)", slow: true,
    kind: "baseline" }, // 同上。分母が違う=データが変わった/一致数が下がった=回帰、で区別する運用
];

/** ★ この一覧が見ていないもの。緑でも安心しないための明示 */
const NOT_COVERED = [
  "訪問入浴の ★ 実データ — 0 行 (check:bath-fixture はモック。★ 実データでは一度も通っていない)",
  "介護予防支援(46) — ★ レセプトが 0 件",
  "福祉用具 — ★ ほのぼの実出力が手元に 1 本も無い (月 ¥17,527,920)",
  "住宅改修 — ★ 請求の実装が存在しない (5年 ¥113,055,753)",
  "payroll-app の給与本体 — ★ 別アプリ。apps/payroll-app 側で回す",
  "国保連からの通知取込 — ★ 実ファイルで一度も検証していない (check:kokuho-tsuchi はモック fixture のみ。" +
    "実ファイルは repo 内のどこにも見つからず、初回取込時のプレビュー目視確認が必須。" +
    "また過誤決定(取消)通知は仕様書上も専用フィールドが無く、マイナス金額の通常通知と構造上区別できない)",
];

const results: { name: string; ok: boolean; ms: number; skipped?: boolean; out?: string; kind: "strict" | "baseline"; knownDiff?: number; noSample?: boolean }[] = [];
for (const c of CHECKS) {
  const kind = c.kind ?? "strict";
  if (FAST && c.slow) { results.push({ name: c.name, ok: true, ms: 0, skipped: true, kind, knownDiff: c.knownDiff }); continue; }
  process.stdout.write(`\n${"=".repeat(70)}\n▶ ${c.name}  — ${c.why}\n${"=".repeat(70)}\n`);
  const t = Date.now();
  // ⚠ stdio:"inherit" だと、この出力を tail 等に通したとき ★ 子の出力だけ落ちる。
  //   2026-09-04 に実際に踏んだ: invariant が FAIL したのに ★ 理由が残らなかった。
  //   pipe で受けて自分で出し、失敗したぶんは ★ 末尾に再掲する。
  const r = spawnSync("npm", ["run", c.script], { shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  process.stdout.write(out);
  results.push({ name: c.name, ok: r.status === 0, ms: Date.now() - t, out, kind, knownDiff: c.knownDiff, noSample: looksLikeNoSampleSkip(out) });
}

console.log(`\n${"=".repeat(70)}\n結果\n${"=".repeat(70)}`);
for (const r of results) {
  const mark = r.skipped ? "－ skip" : r.noSample ? "？ 未検証" : r.ok ? "  PASS" : "★ FAIL";
  const kindTag = r.kind === "baseline" ? " [基準値]" : "";
  const noSampleTag = r.noSample ? " (サンプル未投入。合格ではない)" : "";
  console.log(`${mark}  ${r.name.padEnd(16)} ${r.skipped ? "" : `${(r.ms / 1000).toFixed(1)}s`}${kindTag}${noSampleTag}`);
}
const failed = results.filter((r) => !r.ok);
console.log("");
console.log("⚠ この一覧が ★ 見ていないもの:");
for (const n of NOT_COVERED) console.log(`   ${n}`);
console.log("");

// ★ [基準値] は「0件PASS」ではない。既知の差・既知のリスクを許容している検査を一覧化する
// (2026-09-05 claude-06 指摘: PASSの中に2種類が混ざっていて出力から区別が付かなかった)。
const baselineChecks = results.filter((r) => r.kind === "baseline" && !r.skipped);
if (baselineChecks.length) {
  console.log("★ 基準値方式の検査 (既知の差を許容したうえでのPASS。0件PASSではない):");
  for (const r of baselineChecks) {
    console.log(`   ${r.name.padEnd(16)} ${r.knownDiff != null ? `既知 ${r.knownDiff} 件` : "(件数は出力本文を参照)"}`);
  }
  const summable = baselineChecks.filter((r) => r.knownDiff != null);
  if (summable.length) {
    const total = summable.reduce((s, r) => s + (r.knownDiff ?? 0), 0);
    console.log(`   → 合計 (同一単位=既知差件数で数えられるもののみ): ${total} 件 (${summable.map((r) => r.name).join(" + ")})`);
  }
  console.log("");
}
const noSampleChecks = results.filter((r) => r.noSample);
if (noSampleChecks.length) {
  console.log(`？ サンプル未投入で「合格」でも「不合格」でもない検査: ${noSampleChecks.map((r) => r.name).join("、")}`);
  console.log("");
}
if (failed.length) {
  // ★ 失敗したものの出力を末尾に再掲する。上に流れて見えなくなるため
  const bar = "=".repeat(70);
  for (const f of failed) {
    console.log(`\n${bar}\n★ FAIL の再掲 — ${f.name}\n${bar}`);
    console.log((f.out ?? "").split("\n").slice(-40).join("\n"));
  }
  console.log(`\n★ FAIL ${failed.length} 件: ${failed.map((f) => f.name).join(" / ")}`);
  process.exit(1);
}
console.log(`PASS — ${results.filter((r) => !r.skipped).length} 本${FAST ? " (★ --fast: 伝送突合を飛ばしています)" : ""}`);
