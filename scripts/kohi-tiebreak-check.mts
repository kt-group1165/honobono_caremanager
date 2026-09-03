/**
 * 公費1 の選択が変わっていないかを 実データで測る (READ ONLY)
 *
 *   MONTH=2026-06 npx tsx scripts/kohi-tiebreak-check.mts --save   # 変更前に保存
 *   (コードを変える)
 *   MONTH=2026-06 npx tsx scripts/kohi-tiebreak-check.mts          # 保存分と比較
 *
 * ⚠ **本番の関数 (`resolveKohisForMonth` / `resolveKohiForMonth`) をそのまま呼ぶ。**
 *   比較子を写して並べ直すと、片方だけ直したときに乖離する。
 *
 * ── なぜ要るか ──────────────────────────────────────────────────────────
 *   公費の決め手は 優先度 → 制度優先順位 → **start_date 最新**。
 *   `null` を `""` に落とすので **start_date がある行が必ず勝つ** (null = 最古扱い)。
 *   取込ごとに start_date の有無が綺麗に分かれている:
 *     [MEISAI公費] 232 行 start_date あり 0/232   ← ほのぼのが請求に使う番号。必ず負ける
 *     [居宅STEP1]   70 行 あり 70/70 / [公費マスタ] 54 行 あり 54/54   ← 必ず勝つ
 *   → 「最新を採る」つもりの規則が **古いほうを採る規則**になっていた。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { resolveKohisForMonth, resolveKohiForMonth } from "@/lib/kohi";

const SAVE = process.argv.includes("--save");
const MONTH = process.env.MONTH ?? "2026-06";
const [Y, M] = MONTH.split("-").map(Number);
const SNAP = new URL(`../migrations/_kohi_tiebreak_${MONTH}.json`, import.meta.url);

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function all<T>(table: string, cols: string, order: string): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from(table).select(cols).order(order).range(f, f + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

const rows = await all<{ client_id: string }>("client_kohi_records", "client_id", "id");
const ids = [...new Set(rows.map((r) => r.client_id))];
console.log(`【分母】公費を持つ利用者 ${ids.length} 名 / 対象月 ${MONTH}`);

const plural = await resolveKohisForMonth(sb, ids, Y, M);
const singular = await resolveKohiForMonth(sb, ids, Y, M);
if (plural.fallback || singular.fallback) {
  console.log("⚠ 旧方式にフォールバックしている。**合格とは言わない**");
  process.exit(1);
}

const key = (k: { hobetsu: string; futansha: string | null; jukyusha: string | null; honninFutan: number } | null | undefined) =>
  k ? `${k.hobetsu}|${k.futansha ?? ""}|${k.jukyusha ?? ""}|${k.honninFutan}` : "(なし)";

const snap: Record<string, { p: string; s: string; n: number }> = {};
let multi = 0;
for (const id of ids) {
  const list = plural.byClient.get(id) ?? [];
  if (list.length > 1) multi++;
  snap[id] = { p: key(list[0]), s: key(singular.byClient.get(id)), n: list.length };
}
console.log(`  ${MONTH} に有効な公費が 2 件以上ある利用者: ${multi} 名 (= 選択が発動する)`);

// ★ 2 つの API が同じ 公費1 を返すか (違うと サービスによって公費が変わる)
const apiDiff = ids.filter((id) => snap[id].p !== snap[id].s && snap[id].p !== "(なし)");
console.log(`  ★ 複数版と単数版で 公費1 が違う利用者: ${apiDiff.length} 名 ${apiDiff.length ? "🔴" : "✅"}`);

if (SAVE) {
  writeFileSync(SNAP, JSON.stringify(snap, null, 1));
  console.log(`\n  保存しました → migrations/_kohi_tiebreak_${MONTH}.json`);
  console.log(`  コードを変えたあと --save 無しで実行すると差分が出ます`);
  process.exit(0);
}

if (!existsSync(SNAP)) {
  console.log(`\n⚠ 保存された結果がありません。先に --save で実行してください`);
  process.exit(1);
}
const before = JSON.parse(readFileSync(SNAP, "utf8")) as typeof snap;

const changed: string[] = [];
for (const id of ids) {
  const b = before[id];
  if (!b) { changed.push(`${id}: ★ 保存時に存在しなかった利用者`); continue; }
  if (b.p !== snap[id].p) changed.push(`${id}|複数版 ${b.p} → ${snap[id].p}`);
  if (b.s !== snap[id].s) changed.push(`${id}|単数版 ${b.s} → ${snap[id].s}`);
}
console.log(`\n══ 変更前後の差 ══`);
console.log(`  ★ 公費1 が変わった: ${changed.length} 件`);
if (changed.length) {
  const cids = [...new Set(changed.map((c) => c.split("|")[0]))];
  const { data: cl } = await sb.from("clients").select("id, name").in("id", cids.slice(0, 100));
  const nm = new Map((cl ?? []).map((c) => [c.id, c.name]));
  for (const c of changed) {
    const [id, ...rest] = c.split("|");
    console.log(`   ${nm.get(id) ?? id}  ${rest.join("|")}`);
  }
}
console.log(`\n⚠ 「変わらない」ことを確かめる検査。**変わってよいのは意図した利用者だけ**。`);
