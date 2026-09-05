/**
 * ★ 居宅の伝送バイト照合を 回帰網に入れる (READ ONLY)
 *
 *   npm run check:kyotaku-diff
 *   npm run check:kyotaku-diff -- --update    ★ 基準値を今の値で書き直す
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   ★ 引き継ぎに「居宅 15 事業所 バイト一致 (2026-08-21)」とあるが、
 *   ★ 2026-09-05 に回したら 全事業所に差が出ていた。
 *   ★ 原因は コードの回帰ではなく ★ 認定データの更新だった:
 *     8/31 に利用者マスタを出し直して 新しい認定が入り、
 *     古い認定の終了日が 11/30 → 6/30 に変わった。
 *     ★ ほのぼのの伝送は「7/10 送信時点の姿」なので 当然ずれる。
 *   ★ 検査が無かったので 8/31 に壊れたことに 誰も気づいていなかった。
 *
 * ⚠ ★ 「差 0 を目指す検査」ではありません。★ ほのぼのの伝送は過去の写しなので、
 *   ★ 当方のデータが正しく更新されるほど 差は増えます。
 *   ★ 見張るのは「★ 分母が同じなのに 一致が減った」= ★ 回帰 だけ。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPDATE = process.argv.includes("--update");
const MONTH = process.env.MONTH ?? "2026-06";
const EXPECTED = join(__dirname, "kyotaku-diff-expected.json");
const TMP = join(__dirname, "..", ".kyotaku-diff.tmp.json");

type Cell = { newRows: number; honoRows: number; match: number; diff: number } | null;
type Row = { area: string; officeId: string; s: Cell; k: Cell };

console.log(`居宅 伝送バイト照合の回帰 — ${MONTH}  (2〜4 分かかります)\n`);
execFileSync("npx", ["tsx", join(__dirname, "kyotaku-densou-diff-all.mts")], {
  env: { ...process.env, MONTH, KYOTAKU_DIFF_JSON: TMP },
  stdio: "inherit", shell: true,
});
if (!existsSync(TMP)) { console.log("★ FAIL 突合の JSON が出ていません。"); process.exit(1); }
const now = JSON.parse(readFileSync(TMP, "utf8")) as { month: string; rows: Row[] };
if (now.rows.length === 0) { console.log("★ FAIL 0 拠点です。合格ではありません。"); process.exit(1); }

if (UPDATE || !existsSync(EXPECTED)) {
  writeFileSync(EXPECTED, JSON.stringify({
    _readme: [
      "★ 居宅の伝送バイト照合の基準値。",
      "★ 差 0 を目指す検査ではない。ほのぼのの伝送は「送信時点の写し」なので、",
      "★ 当方のデータが正しく更新されるほど 差は増える。",
      "★ 見張るのは「分母 (newRows/honoRows) が同じなのに 一致 (match) が減った」= 回帰 だけ。",
      "⚠ 2026-08-21 に「15 事業所 バイト一致」が確認されたが、",
      "  ★ 8/31 の利用者マスタ出し直しで 認定が更新され、成り立たなくなった。",
      "  ★ 認定の終了日が 11/30 → 6/30 に変わった例を実データで確認済み。",
      "⚠ 悪化したまま --update すると 穴を焼き付ける。★ 先に原因を潰すこと。",
    ],
    month: now.month, rows: now.rows,
  }, null, 2) + "\n", "utf8");
  console.log(`\n★ 基準値を書きました: ${EXPECTED} (${now.rows.length} 拠点)`);
  process.exit(0);
}

const exp = JSON.parse(readFileSync(EXPECTED, "utf8")) as { month: string; rows: Row[] };

// ★ 負のコントロール: NEGATIVE_CONTROL=1 で 基準値をメモリ上だけ 1 上げる。
//   ★ FAIL するのが正しい。PASS したら この検査は効いていない。
//   ⚠ ★ ファイルは書き換えない (途中で落ちても 基準値が壊れないようにするため)。
if (process.env.NEGATIVE_CONTROL === "1") {
  const t = exp.rows.find((r) => r.s);
  if (!t?.s) { console.log("★ FAIL 負のコントロールを仕掛けられません (基準値に S がありません)"); process.exit(1); }
  t.s.match += 1;
  console.log(`⚠ ★ 負のコントロール中: ${t.area} の S 基準値を 1 上げました → ★ FAIL になるのが正しい
`);
}

const byArea = new Map(exp.rows.map((r) => [r.area, r]));
const fails: string[] = [];
const notes: string[] = [];
let ok = 0;

for (const r of now.rows) {
  const e = byArea.get(r.area);
  if (!e) { notes.push(`○ ${r.area}: 基準値に無い (新規)`); continue; }
  for (const kind of ["s", "k"] as const) {
    const a = r[kind], b = e[kind];
    if (!a && !b) continue;
    if (!a || !b) { fails.push(`★ ${r.area} ${kind.toUpperCase()}: 片方が測れていない`); continue; }
    if (a.newRows !== b.newRows || a.honoRows !== b.honoRows) {
      notes.push(`○ ${r.area} ${kind.toUpperCase()}: データが変わった (分母 new ${b.newRows}→${a.newRows} / hono ${b.honoRows}→${a.honoRows} / 一致 ${b.match}→${a.match})`);
      continue;
    }
    if (a.match < b.match) fails.push(`★ ${r.area} ${kind.toUpperCase()}: ★ 回帰 — 分母は同じ (new ${a.newRows} / hono ${a.honoRows}) なのに 一致 ${b.match}→${a.match}`);
    else if (a.match > b.match) notes.push(`○ ${r.area} ${kind.toUpperCase()}: 改善 一致 ${b.match}→${a.match} (--update で基準値を上げてください)`);
    else ok++;
  }
}

console.log("");
for (const n of notes) console.log(`  ${n}`);
console.log("");
if (fails.length) {
  for (const f of fails) console.log(`  ${f}`);
  console.log(`\n★ FAIL ${fails.length} 件 (一致/改善 ${ok} / データが変わった ${notes.length})`);
  process.exit(1);
}
console.log(`PASS — 一致 ${ok} / データが変わった ${notes.length}`);
console.log("⚠ ★ 差そのものは 0 ではありません。★ ほのぼのの伝送は送信時点の写しなので、");
console.log("   ★ 当方の認定が更新されるたび 差は増えます。★ 回帰だけを見張っています。");
