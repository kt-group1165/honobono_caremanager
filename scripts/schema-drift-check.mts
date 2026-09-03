/**
 * コードが参照する列が DB に実在するか (コード ⇄ スキーマ の乖離) を洗う (READ ONLY)
 *
 *   npx tsx scripts/schema-drift-check.mts
 *
 * ── なぜ要るか (2026-09-03) ───────────────────────────────────────────────
 *   利用者請求書 (`invoices`) が 0 行なのを「まだ使っていない」と思って調べたら、
 *   ★ **コードが書く列 `issued_date` / `copay_amount` が DB に無く、
 *     保存が必ず失敗する**状態だった。0 行は「未使用」ではなく「壊れている」印だった。
 *   → **同じ乖離が他にもあるか**をまとめて見る。
 *
 * ── 何を見るか ────────────────────────────────────────────────────────────
 *   `.from("table").select("a, b, c")` の **文字列リテラル**だけを対象にする。
 *   ★ insert/update の object literal は解析が不確実なので **対象外**
 *     (regex で TS のオブジェクトを読むと誤検出が出る)。
 *   → **読みの乖離は全部見つかる / 書きの乖離は select にも出てくるものだけ**。
 *     `invoices` は select にも `issued_date` があったのでこの方法で捕まる。
 *
 * ⚠ 埋め込み関係 (`office:offices(name)`) や `count` は除く。
 * ⚠ 動的に組む select は拾えない。
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

const APPS_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const DIRS = [
  "kaigo-app/src", "order-app/app", "order-app/lib",
  "payroll-app/src", "calendar-app/app", "calendar-app/lib",
];

/** table → 列 → その列を書いている file の集合 */
const want = new Map<string, Map<string, Set<string>>>();
let files = 0;
for (const dir of DIRS) {
  let out = "";
  try {
    out = execFileSync("grep", ["-rl", "--include=*.ts", "--include=*.tsx", '\\.from("', path.join(APPS_ROOT, dir)],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch { continue; }
  for (const file of out.split("\n").filter(Boolean)) {
    files++;
    const src = readFileSync(file, "utf8");
    // .from("t")…select("a, b, c")  — 間に .eq() 等が挟まらない直後のみを見る (誤対応を避ける)
    for (const m of src.matchAll(/\.from\("([a-z_0-9]+)"\)\s*\n?\s*\.select\(\s*"([^"]*)"/g)) {
      const [, table, cols] = m;
      if (!want.has(table)) want.set(table, new Map());
      const byCol = want.get(table)!;
      for (const raw of cols.split(",")) {
        const c = raw.trim();
        // 埋め込み / エイリアス / ワイルドカード / count は対象外
        if (!c || c === "*" || c.includes("(") || c.includes(":")) continue;
        if (!/^[a-z_][a-z_0-9]*$/.test(c)) continue;
        if (!byCol.has(c)) byCol.set(c, new Set());
        byCol.get(c)!.add(file.split(/[\\/]/).slice(-2).join("/"));
      }
    }
  }
}
const tables = [...want.keys()].sort();
console.log(`【分母】${files} file から ${tables.length} table / ` +
  `${tables.reduce((s, t) => s + want.get(t)!.size, 0)} 列参照を集めた`);

let bad = 0, checked = 0;
for (const t of tables) {
  const cols = [...want.get(t)!.keys()];
  const missing: string[] = [];
  for (const c of cols) {
    checked++;
    const { error } = await sb.from(t).select(c).limit(1);
    // 42703 = undefined_column / PGRST204 = schema cache に無い
    if (error && (error.code === "42703" || error.code === "PGRST204")) missing.push(c);
    else if (error && error.code === "42P01") { missing.push(`(table 自体が無い)`); break; }
  }
  if (!missing.length) continue;
  bad++;
  console.log(`\n★ ${t}`);
  for (const c of missing) {
    const where = [...(want.get(t)!.get(c) ?? [])].slice(0, 3).join(" / ");
    console.log(`    列 ${c.padEnd(24)} ${where}`);
  }
}

console.log(`\n══ ${bad ? "★ " : "OK "}乖離のある table: ${bad} / ${tables.length} (${checked} 列を確認) ══`);
if (!bad) console.log(`  コードが select する列はすべて DB にある`);
console.log(`\n⚠ 見ているのは **select の文字列リテラルだけ**。`);
console.log(`  insert/update の object literal は解析が不確実なので対象外 (誤検出を出さないため)。`);
console.log(`  → 「書きだけ乖離している列」は取り逃がす。★ 0 件でも「乖離なし」とは言えない。`);
console.log(`⚠ 実例: invoices の issued_date / copay_amount は **select にも出ていた**ので捕まる。`);
console.log(`  0 行の table を見つけたら、まず ここで列の乖離を疑うこと。`);
