/**
 * 実装はあるが **一度も使われていない** table を洗い出す (READ ONLY)
 *
 *   npx tsx scripts/unused-tables-check.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   今日 1 日で「実装済みだが実データ 0 件」を **7 件別々に踏んだ**:
 *     利用実費 (riyou_jippi_entries) / キャンセル (status='cancelled') /
 *     上限価格が請求に効かない / 書類タスクの運用実績 /
 *     member_groups / passkey の 2 台目許可 / 主治医意見書
 *   ★ 1 件ずつ偶然見つけるのではなく、**まとめて数える**。
 *   本番稼働の前に「作ったが使っていない」を棚卸しできる。
 *
 * ⚠ **0 件 = バグ ではない。**理由は 5 通りある:
 *     A 事業自体が未開始      (訪問入浴など)
 *     B 運用フローが未開始    (入金消込・過誤再請求・利用者請求書の発行)
 *     C 機能はあるが低採用    (グループ・passkey 2 台目)
 *     D 上流が空だから空      (別の表に実体がある)
 *     E ★ バグで書けていない  (calendar-app の backups = バケット不在)
 *   ★ **この script は分類しない。**数えて、参照元の file を出すだけ。
 *     分類は中身を読める人がやる。推測で「未使用」と決めない。
 *
 * ⚠ 参照元は `.from("table")` の grep なので、**動的に組む箇所は拾えない**。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log("⚠ SUPABASE_SERVICE_ROLE_KEY が無いのでスキップ (anon だと RLS で 0 行になり誤判定する)");
  process.exit(0);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

/** app のソースから `.from("...")` を集める */
// ⚠ cwd ではなく **この file の位置** から解決する (どこから実行しても同じ結果にする)
const APPS_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const APPS = [
  ["kaigo-app", "kaigo-app/src"],
  ["order-app", "order-app/app"],
  ["order-app", "order-app/lib"],
  ["payroll-app", "payroll-app/src"],
  ["calendar-app", "calendar-app/app"],
  ["calendar-app", "calendar-app/lib"],
] as const;

const refs = new Map<string, Set<string>>(); // table → "app: path"
for (const [app, dir] of APPS) {
  let out = "";
  try {
    out = execFileSync("grep", ["-rn", "--include=*.ts", "--include=*.tsx", '\\.from("', path.join(APPS_ROOT, dir)],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch { continue; } // 該当なし / dir 不在は grep が非 0 で終わる
  for (const line of out.split("\n")) {
    // ⚠ Windows は先頭が `C:\...` なので `[^:]+` だと **ドライブレター 1 文字**を掴む。
    //   行番号の直前までを file 名として採る。
    const mFile = /^(.+?):\d+:/.exec(line);
    for (const m of line.matchAll(/\.from\("([a-z_0-9]+)"\)/g)) {
      const t = m[1];
      if (!refs.has(t)) refs.set(t, new Set());
      refs.get(t)!.add(`${app}: ${(mFile?.[1] ?? "").split(/[\\/]/).slice(-2).join("/")}`);
    }
  }
}
const tables = [...refs.keys()].sort();
console.log(`【分母】app が参照する table ${tables.length} 種 (\`.from("...")\` の grep)`);

const counts = await Promise.all(tables.map(async (t) => {
  const { count, error } = await sb.from(t).select("*", { count: "exact", head: true });
  return { t, n: error ? null : (count ?? 0), err: error?.code ?? null };
}));

const zero = counts.filter((r) => r.n === 0);
const few = counts.filter((r) => r.n != null && r.n > 0 && r.n <= 5);
const err = counts.filter((r) => r.n == null);

console.log(`\n══ ★ 0 行 — ${zero.length} 種 (${Math.round(zero.length * 100 / tables.length)}%) ══`);
for (const r of zero.sort((a, b) => a.t.localeCompare(b.t))) {
  console.log(`  ${r.t}`);
  console.log(`      ${[...(refs.get(r.t) ?? [])].slice(0, 3).join(" / ")}`);
}
console.log(`\n══ 1〜5 行 (使い始めか、テストの残骸か) — ${few.length} 種 ══`);
for (const r of few.sort((a, b) => a.n! - b.n!)) {
  console.log(`  ${String(r.n).padStart(2)}  ${r.t}   ${[...(refs.get(r.t) ?? [])].slice(0, 2).join(" / ")}`);
}
if (err.length) {
  console.log(`\n══ ⚠ 取得できない (存在しない / RLS) — ${err.length} 種 ══`);
  for (const r of err) console.log(`  ${r.t}  (${r.err})`);
}

console.log(`\n⚠ **0 件 = バグ ではない。**A 事業未開始 / B 運用フロー未開始 / C 低採用 /`);
console.log(`  D 上流が空 / E ★ バグで書けていない、の 5 通りある。`);
console.log(`  ★ この script は分類しない。数えて参照元を出すだけ。**推測で「未使用」と決めない。**`);
console.log(`⚠ 参照元は grep なので **動的に組む箇所は拾えない**。0 行でも使われている可能性はある。`);
