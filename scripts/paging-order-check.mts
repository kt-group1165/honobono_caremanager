/**
 * ページングしているのに order が無いクエリを洗い出す。
 *
 *   cd apps/kaigo-app
 *   npm run check:paging
 *   npm run check:paging -- --all      applied_archive も含める
 *
 * **READ ONLY**。ファイルを読むだけ。
 *
 * ── なぜ要るか ──────────────────────────────────────────────────────────
 *   PostgREST / Postgres は **ORDER BY 無しの行順を保証しない**。
 *   1000 件ずつ Range や .range() で刻むと、ページごとに並びが変わって
 *   **同じ行が 2 回来たり 1 回も来なかったり**する。
 *
 *   2026-09-01 に実際に踏んだ: 10 万行の kaigo_service_codes を order 無しで
 *   取ったら「身体１生活１」が丸ごと落ち、**同じコードを 2 回流して
 *   20,206 件 → 34,696 件** と結果が変わった。
 *
 *   ⚠ 症状は「エラー」ではなく **「件数が少し足りない」**。
 *     突合では「請求漏れ」に見え、集計では金額が少し合わないだけなので、
 *     原因にたどり着けない。
 *
 * ── 判定の仕方 (ヒューリスティック) ──────────────────────────────────────
 *   ① `.range(` を含む式に `.order(` が無い          → 疑い
 *   ② `Range:` ヘッダで回す fetch の URL に order= が無い → 疑い
 *
 *   ⚠ **これは静的な当たり判定なので誤検出する。**
 *     ・変数に組み立てた URL に order を入れている
 *     ・1 ページで終わる (総数が 1000 未満と分かっている)
 *     ・`.single()` / `.maybeSingle()` で 1 行しか取らない
 *     いずれも「疑い」に出るが問題ない。**人が見て判断する**ための一覧。
 *
 *   ⚠ 逆に「order がある = 安全」とも限らない。
 *     順序が **一意でない列** (visit_date だけ 等) だと同順の行の並びが不定になり、
 *     やはりページ境界でずれる。id や主キーを最後に足すのが確実。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const REPO = path.resolve(KAIGO, "../..");
const INCLUDE_ARCHIVE = process.argv.includes("--all");

type Hit = { file: string; line: number; kind: "range" | "header"; snippet: string; table: string | null };

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === "node_modules" || name === ".next" || name === ".git") continue;
    if (!INCLUDE_ARCHIVE && name === "applied_archive") continue;
    const p = path.join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { walk(p, out); continue; }
    if (/\.(ts|tsx|mts|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

/** index を含む「式」のだいたいの範囲を返す。前後の ; { } で区切る */
function statementAround(src: string, idx: number): string {
  let a = idx;
  while (a > 0 && !";{}".includes(src[a - 1])) a--;
  let b = idx;
  while (b < src.length && !";{}".includes(src[b])) b++;
  return src.slice(a, b + 1);
}

const lineOf = (src: string, idx: number) => src.slice(0, idx).split("\n").length;

/** 式から対象テーブル名を拾う。変数で組んでいる (from(table)) ものは null */
function tableOf(stmt: string): string | null {
  const m = /\bfrom\(\s*["'`]([a-z][a-z0-9_]{2,})["'`]\s*\)/.exec(stmt)
    ?? /rest\/v1\/([a-z][a-z0-9_]{2,})/.exec(stmt);
  return m ? m[1] : null;
}

/**
 * 表の行数を数える。
 * **1000 行以下ならページングは 1 ページで終わる**ので、order が無くても結果は変わらない。
 * 実際に直す必要があるのはここを超える表だけ。
 */
async function rowCounts(tables: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const env: Record<string, string> = {};
  try {
    for (const l of readFileSync(path.join(KAIGO, ".env.local"), "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    console.error("⚠ .env.local が読めないので行数で絞り込めない (全件を出す)");
    return out;
  }
  const url = env.NEXT_PUBLIC_SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return out;
  const H = { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact", Range: "0-0" };
  for (const t of tables) {
    try {
      const r = await fetch(`${url}/rest/v1/${t}?select=*`, { headers: H });
      const n = Number((r.headers.get("content-range") ?? "").split("/")[1]);
      if (Number.isFinite(n)) out.set(t, n);
    } catch { /* 数えられない表は「不明」として残す */ }
  }
  return out;
}

function scan(file: string): Hit[] {
  let src: string;
  try { src = readFileSync(file, "utf8"); } catch { return []; }
  const hits: Hit[] = [];

  // ① supabase-js の .range(
  for (let i = src.indexOf(".range("); i >= 0; i = src.indexOf(".range(", i + 1)) {
    const stmt = statementAround(src, i);
    if (stmt.includes(".order(")) continue;
    // 1 行だけ取るものは対象外
    if (/\.(single|maybeSingle)\(/.test(stmt)) continue;
    hits.push({
      file, line: lineOf(src, i), kind: "range", table: tableOf(stmt),
      snippet: stmt.replace(/\s+/g, " ").trim().slice(0, 110),
    });
  }

  // ② Range: ヘッダで回す fetch
  for (let i = src.indexOf("Range:"); i >= 0; i = src.indexOf("Range:", i + 1)) {
    const stmt = statementAround(src, i);
    // 同じ関数の中で order= を組んでいれば見逃す。前後 1200 字を見る
    const near = src.slice(Math.max(0, i - 1200), i + 1200);
    if (/order=/.test(near)) continue;
    hits.push({
      file, line: lineOf(src, i), kind: "header", table: tableOf(near),
      snippet: stmt.replace(/\s+/g, " ").trim().slice(0, 110),
    });
  }
  return hits;
}

async function main() {
  const roots = [
    path.join(REPO, "apps"),
    path.join(REPO, "migrations"),
  ];
  const files = roots.flatMap((r) => walk(r));
  const hits = files.flatMap(scan);

  console.log("ページングしているのに order が無いクエリ (静的な当たり判定)\n");
  if (!hits.length) { console.log("✓ 見つからなかった"); return; }

  // ── 1000 行を超える表だけに絞る ──
  //   1000 行以下ならページングは 1 ページで終わるので order は結果に影響しない。
  const counts = await rowCounts([...new Set(hits.map((h) => h.table).filter(Boolean) as string[])]);
  const risky = hits.filter((h) => h.table && (counts.get(h.table) ?? 0) > 1000);
  const small = hits.filter((h) => h.table && (counts.get(h.table) ?? 0) <= 1000
    && counts.has(h.table));
  const unknown = hits.length - risky.length - small.length;

  console.log(`  ${hits.length} 箇所のうち`);
  console.log(`    🔴 1000 行超の表      ${String(risky.length).padStart(4)} 箇所  ← ここだけ直せばよい`);
  console.log(`    ・ 1000 行以下の表    ${String(small.length).padStart(4)} 箇所  (2 ページ目が無いので無害)`);
  console.log(`    ?  表を特定できない   ${String(unknown).padStart(4)} 箇所  (変数で組んでいる)
`);

  const byFile = new Map<string, Hit[]>();
  for (const h of risky) {
    const rel = path.relative(REPO, h.file).replace(/\\/g, "/");
    if (!byFile.has(rel)) byFile.set(rel, []);
    byFile.get(rel)!.push(h);
  }
  for (const [rel, hs] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`■ ${rel}  (${hs.length} 箇所)`);
    for (const h of hs.slice(0, 4)) {
      console.log(`   :${String(h.line).padStart(5)}  [${h.table} ${(counts.get(h.table!) ?? 0).toLocaleString()} 行]  ${h.snippet.slice(0, 84)}`);
    }
    if (hs.length > 4) console.log(`   …他 ${hs.length - 4} 箇所`);
  }
  console.log(`\n${byFile.size} ファイル / ${hits.length} 箇所`);
  console.log(`
⚠ **これは疑いの一覧であって、全部がバグではない。**
  1 ページで終わるもの・変数に order を組み込んでいるものも出る。
  直すときは「その問い合わせが 1000 行を超えうるか」で判断する。

⚠ order を足すときは **一意に定まる列**にする (id を最後に足すのが確実)。
  visit_date だけだと同じ日の行の並びが不定で、結局ページ境界でずれる。`);
}

main();
