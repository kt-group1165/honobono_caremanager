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

type Check = { name: string; script: string; why: string; slow?: boolean };

/** ★ 落ちたら金額か返戻に効くものだけ */
const CHECKS: Check[] = [
  { name: "smoke", script: "smoke", why: "集計の回帰 (金額)。指紋で「データが変わった」と区別する" },
  { name: "invariant", script: "check:invariant", why: "★ 17条件を 全事業所・4制度に当てる (内部の関係が壊れていないか)" },
  { name: "densou", script: "check:densou", why: "伝送前の事前点検 (返戻・過大請求の元)" },
  { name: "anon", script: "check:anon", why: "★ 個人情報が anon から読めないか (分母は PostgREST の 228 表)" },
  { name: "addon-lines", script: "check:addon-lines", why: "★ 加算行の 書式ずれ (制度で読み方が違う) と マスタ実在" },
  { name: "month-format", script: "check:month-format", why: "★ 月を表す text 列 39 個の 書式ずれ (書く側と読む側で違うと 0 件になる)" },
  { name: "kyotaku-matrix", script: "check:kyotaku-matrix", why: "居宅介護支援の単位数 (加算・減算・逓減)" },
  { name: "idou-summary", script: "check:idou-summary", why: "移動支援の負担額・上限" },
  { name: "riyou-final", script: "check:riyou-final", why: "利用者請求書の最終額 (軽減・実費・繰越)" },
  { name: "sougou-shoguu", script: "check:sougou-shoguu", why: "総合事業の処遇改善 (自治体独自率)" },
  { name: "shoguu-4impl", script: "check:shoguu-4impl", why: "★ 処遇改善の % 計算が 4 制度の実装で一致するか" },
  { name: "service-code-gap", script: "check:service-code-gap", why: "★ 単位数0・加算率未設定のコードが 実発火しうるか" },
  { name: "teigen", script: "check:teigen", why: "逓減制" },
  { name: "shogai-jogen", script: "check:shogai-jogen", why: "障害の上限額管理" },
  { name: "tokutei", script: "check:tokutei", why: "特定事業所加算" },
  { name: "kyotaku-diff", script: "check:kyotaku-diff", why: "★ 居宅の伝送バイト照合 (ほのぼの実出力との突合。認定更新で差が増えるので 回帰だけ見張る)", slow: true },
  { name: "densou-diff", script: "check:densou-diff", why: "★ ほのぼの実出力との突合 (介護保険7拠点 + 障害17拠点)", slow: true },
];

/** ★ この一覧が見ていないもの。緑でも安心しないための明示 */
const NOT_COVERED = [
  "訪問入浴 — ★ 実データが 0 行。サンプルでしか通せない",
  "介護予防支援(46) — ★ レセプトが 0 件",
  "福祉用具 — ★ ほのぼの実出力が手元に 1 本も無い (月 ¥17,527,920)",
  "住宅改修 — ★ 請求の実装が存在しない (5年 ¥113,055,753)",
  "payroll-app の給与本体 — ★ 別アプリ。apps/payroll-app 側で回す",
  "国保連からの通知取込 — ★ 実ファイルで一度も検証していない",
];

const results: { name: string; ok: boolean; ms: number; skipped?: boolean; out?: string }[] = [];
for (const c of CHECKS) {
  if (FAST && c.slow) { results.push({ name: c.name, ok: true, ms: 0, skipped: true }); continue; }
  process.stdout.write(`\n${"=".repeat(70)}\n▶ ${c.name}  — ${c.why}\n${"=".repeat(70)}\n`);
  const t = Date.now();
  // ⚠ stdio:"inherit" だと、この出力を tail 等に通したとき ★ 子の出力だけ落ちる。
  //   2026-09-04 に実際に踏んだ: invariant が FAIL したのに ★ 理由が残らなかった。
  //   pipe で受けて自分で出し、失敗したぶんは ★ 末尾に再掲する。
  const r = spawnSync("npm", ["run", c.script], { shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  process.stdout.write(out);
  results.push({ name: c.name, ok: r.status === 0, ms: Date.now() - t, out });
}

console.log(`\n${"=".repeat(70)}\n結果\n${"=".repeat(70)}`);
for (const r of results) {
  const mark = r.skipped ? "－ skip" : r.ok ? "  PASS" : "★ FAIL";
  console.log(`${mark}  ${r.name.padEnd(16)} ${r.skipped ? "" : `${(r.ms / 1000).toFixed(1)}s`}`);
}
const failed = results.filter((r) => !r.ok);
console.log("");
console.log("⚠ この一覧が ★ 見ていないもの:");
for (const n of NOT_COVERED) console.log(`   ${n}`);
console.log("");
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
