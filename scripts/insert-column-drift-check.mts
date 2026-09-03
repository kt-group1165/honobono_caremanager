/**
 * insert / upsert の **列名の乖離**を洗い出す (READ ONLY)
 *
 *   npx tsx scripts/insert-column-drift-check.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   schema-drift-check.mts は **select の文字列リテラル**だけを見ている
 *   (「insert/update の object literal は解析が不確実なので対象外」と自分で書いている)。
 *   → **「書きだけ乖離している列」を取り逃がす**。
 *
 *   これは実際に起きている型で、そちらのコメントにも実例が残っている:
 *     invoices の issued_date / copay_amount … たまたま select にも出ていたので捕まった
 *   ★ select に出ない insert 専用の列は、いま誰も見ていない。
 *   存在しない列を 1 つでも渡すと PostgREST は **行ごと拒否 (PGRST204)** するので、
 *   その表は **永久に 0 行**になる。「0 行 = 未使用」と読むと見逃す (E 分類)。
 *
 * ★ この検査が証明しないこと (ルール 3-1):
 *   - 解析できるのは **インラインのオブジェクトリテラル**だけ。
 *     `.insert(rows)` のように変数を渡す箇所・スプレッドを含む箇所は **未解析**。
 *     → 未解析の件数を必ず出す (分母。0 件でも「乖離なし」とは言えない)
 *   - 動的キー (`[x]: v`) は読めないので、その object 全体を未解析にする
 *   - 列が在っても **値**が正しいかは見ていない
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log("⚠ SUPABASE_SERVICE_ROLE_KEY が無いのでスキップ (anon だと RLS で誤判定する)");
  process.exit(0);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ⚠ import.meta.url は URL エンコードされている (日本語パスで %E4%BB%8B… になる)。
//   fileURLToPath を通さないと ENOENT になる。
const APPS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e === ".git" || e === "dist") continue;
    const p = path.join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

/** 対応する閉じ括弧までを返す (文字列・テンプレート・コメントを飛ばす) */
function matchBrace(src: string, start: number): number {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (ch === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i); if (i < 0) return -1; i++; continue; }
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * object literal の中のコメントを落とす (文字列リテラルは保護する)。
 *
 * ⚠ これが無いと **object の中にコメントを 1 行書いただけでその site が未解析になる**。
 *   実際に踏んだ: service-code-import-dialog.tsx の insert に説明コメントを足したら
 *   その表の解析が丸ごと落ち、**検出済みだった 4 件が「0 件」に化けた**。
 *   「直したら検出が消えた」= 沈黙パターン (2章) そのものなので、必ず落とす。
 */
function stripComments(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      out += ch; i++;
      while (i < s.length && s[i] !== q) { if (s[i] === "\\") { out += s[i]; i++; } out += s[i]; i++; }
      out += s[i] ?? "";
      continue;
    }
    if (ch === "/" && s[i + 1] === "/") { while (i < s.length && s[i] !== "\n") i++; out += "\n"; continue; }
    if (ch === "/" && s[i + 1] === "*") { const e = s.indexOf("*/", i + 2); i = e < 0 ? s.length : e + 1; continue; }
    out += ch;
  }
  return out;
}

/**
 * object literal の**最上位**のキーを取る。読めない形なら null (= 未解析)。
 *
 * ★ スプレッド (`...base`) を含んでいても **書いてあるキーは実際に送られる**ので、
 *   そこだけ拾う (= 部分解析)。存在しない列を 1 つでも渡せば行ごと拒否されるため、
 *   網羅していなくても「余分な列」の検出には十分効く。
 *   ⚠ 逆に「足りない列」は分からない。完全性は主張しない。
 */
function topLevelKeys(obj: string): { keys: string[]; partial: boolean } | null {
  const inner = stripComments(obj.slice(1, -1));
  const partial = inner.includes("...");
  const keys: string[] = [];
  let depth = 0;
  let tokenStart = 0;
  const parts: string[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch; i++;
      while (i < inner.length && inner[i] !== q) { if (inner[i] === "\\") i++; i++; }
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) { parts.push(inner.slice(tokenStart, i)); tokenStart = i + 1; }
  }
  parts.push(inner.slice(tokenStart));
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    if (p.startsWith("...")) continue; // スプレッドは中身が読めないので飛ばす (部分解析)
    // ★ `key:` か shorthand (その部分がまるごと識別子) だけを認める。
    //   緩めると型引数のカンマを列名と誤認する。実例:
    //     content: baseContent as unknown as Record<string, unknown>,
    //   → `<...>` を深さに数えないので ` unknown>` が 1 要素になり
    //     列名 "unknown" として報告されていた (誤検出)。
    //   読めない形は **未解析に倒す** (誤検出を出さない方を優先)。
    const m = /^(?:"([A-Za-z0-9_]+)"|'([A-Za-z0-9_]+)'|([A-Za-z0-9_]+))\s*(?::|$)/.exec(p);
    if (!m) return null;
    const key = m[1] ?? m[2] ?? m[3];
    // shorthand ({ id }) も列名として扱う。`[expr]:` は読めないので未解析
    if (p.startsWith("[")) return null;
    keys.push(key);
  }
  return { keys, partial };
}

type Site = { file: string; line: number; table: string; keys: string[] | null; partial: boolean };

function collect(): Site[] {
  const sites: Site[] = [];
  for (const app of readdirSync(APPS_DIR)) {
    const dir = path.join(APPS_DIR, app);
    let st; try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const file of walk(dir)) {
      const src = readFileSync(file, "utf8");
      const re = /\.from\(\s*["'`]([a-z0-9_]+)["'`]\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const table = m[1];
        // 同じチェーンの中の insert/upsert を探す (次の .from( までの範囲)
        const nextFrom = src.indexOf(".from(", m.index + 1);
        const scope = src.slice(m.index, nextFrom < 0 ? src.length : nextFrom);
        const im = /\.(insert|upsert)\(\s*/.exec(scope);
        if (!im) continue;
        const argStart = m.index + im.index + im[0].length;
        const rel = path.relative(APPS_DIR, file).replace(/\\/g, "/");
        const line = src.slice(0, m.index).split("\n").length;
        if (src[argStart] === "[") {
          // 配列リテラル: 最初の要素だけ見る
          const arrEnd = matchBrace(src, argStart);
          const first = src.indexOf("{", argStart);
          if (arrEnd < 0 || first < 0 || first > arrEnd) { sites.push({ file: rel, line, table, keys: null, partial: false }); continue; }
          const objEnd = matchBrace(src, first);
          const r = objEnd < 0 ? null : topLevelKeys(src.slice(first, objEnd + 1));
          sites.push({ file: rel, line, table, keys: r?.keys ?? null, partial: r?.partial ?? false });
        } else if (src[argStart] === "{") {
          const objEnd = matchBrace(src, argStart);
          const r = objEnd < 0 ? null : topLevelKeys(src.slice(argStart, objEnd + 1));
          sites.push({ file: rel, line, table, keys: r?.keys ?? null, partial: r?.partial ?? false });
        } else {
          sites.push({ file: rel, line, table, keys: null, partial: false }); // 変数を渡している = 未解析
        }
      }
    }
  }
  return sites;
}

async function columnsOf(table: string): Promise<Set<string> | null> {
  const { data, error } = await sb.from(table).select("*").limit(1);
  if (error) return null;
  if (data && data.length > 0) return new Set(Object.keys(data[0] as object));
  // 0 行の表は select("*") から列が取れない → 存在しない列を投げてエラー文から判定する
  return new Set<string>(); // 空 Set = 列が取れなかった (0 行) の印
}

/** 0 行の表: 列ごとに select して 42703 かどうかで存在を判定する */
async function columnExists(table: string, col: string): Promise<boolean> {
  const { error } = await sb.from(table).select(col).limit(1);
  if (!error) return true;
  return !(error.code === "42703" || /does not exist/i.test(error.message));
}

async function main() {
  const sites = collect();
  const tables = [...new Set(sites.map((s) => s.table))].sort();
  console.log(`【分母】insert/upsert の呼出 ${sites.length} 箇所 / ${tables.length} table`);
  const parsed = sites.filter((s) => s.keys !== null);
  const partial = parsed.filter((s) => s.partial);
  console.log(`  うち **インラインのオブジェクトが読めた** ${parsed.length} 箇所`);
  console.log(`    (うち ${partial.length} 箇所は ★ 部分解析 — スプレッドを含むので`);
  console.log(`     「余分な列」は見えるが「足りない列」は見えない)`);
  console.log(`  ★ 未解析 (変数渡し・動的キー) ${sites.length - parsed.length} 箇所 — ここは見ていない\n`);

  // 未解析の site を一覧する (手で当たるため)。表名で絞れる:
  //   LIST_UNPARSED=1                        全部
  //   LIST_UNPARSED=invoices,kokuho_nyukin…  その表だけ
  const listArg = (process.env.LIST_UNPARSED ?? "").trim();
  if (listArg) {
    const filter = listArg === "1" ? null : new Set(listArg.split(",").map((s) => s.trim()));
    const rows = sites.filter((s) => s.keys === null && (!filter || filter.has(s.table)));
    console.log(`── 未解析の site ${rows.length} 件 ${filter ? `(${filter.size} 表に絞り込み)` : "(全部)"} ──`);
    for (const s of rows.sort((a, b) => a.table.localeCompare(b.table) || a.file.localeCompare(b.file))) {
      console.log(`  ${s.table.padEnd(34)} ${s.file}:${s.line}`);
    }
    console.log("");
  }
  if (parsed.length === 0) {
    console.error("✗ 1 箇所も解析できていない = 検査が動いていない");
    process.exit(1);
  }

  const colCache = new Map<string, Set<string> | null>();
  const findings: string[] = [];
  let checkedCols = 0;
  let skippedTables = 0;

  for (const t of tables) {
    const keysHere = [...new Set(parsed.filter((s) => s.table === t).flatMap((s) => s.keys!))];
    if (keysHere.length === 0) continue;
    if (!colCache.has(t)) colCache.set(t, await columnsOf(t));
    const cols = colCache.get(t);
    if (!cols) { skippedTables++; continue; } // 表そのものが引けない
    for (const k of keysHere) {
      checkedCols++;
      const ok = cols.size > 0 ? cols.has(k) : await columnExists(t, k);
      if (!ok) {
        const where = parsed.filter((s) => s.table === t && s.keys!.includes(k))
          .map((s) => `${s.file}:${s.line}`).join(" / ");
        findings.push(`${t}.${k}\n      ${where}`);
      }
    }
  }

  console.log(`確認した (table, 列) の組み合わせ ${checkedCols} 件 / 引けなかった table ${skippedTables} 件\n`);
  if (checkedCols === 0) {
    console.error("✗ 列を 1 つも確認していない = 検査が動いていない");
    process.exit(1);
  }
  if (findings.length === 0) {
    console.log("✅ insert/upsert で **存在しない列**を渡している箇所は見つからなかった");
  } else {
    console.log(`══ ★ 存在しない列を insert している ${findings.length} 件 ══`);
    for (const f of findings) console.log(`  ★ ${f}`);
    console.log(`\n⚠ PostgREST は存在しない列が 1 つでもあると **行ごと拒否** (PGRST204) する。`);
    console.log(`  → その表は永久に 0 行になる。「0 行 = 未使用」と読まないこと。`);
  }
  console.log(`\n⚠ 未解析 ${sites.length - parsed.length} 箇所 + 部分解析 ${partial.length} 箇所は完全には見ていない。
  **0 件でも「乖離なし」とは言えない。**`);
}

main().catch((e) => { console.error(e); process.exit(1); });
