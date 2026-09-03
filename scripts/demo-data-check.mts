/**
 * 本番の `clients` に混ざっているデモ / テスト利用者を洗い出す (READ ONLY)
 *
 *   npx tsx scripts/demo-data-check.mts
 *
 * ── なぜ要るか (2026-09-03) ───────────────────────────────────────────────
 *   「課題整理総括表 / 評価表 が 10 件しか無い」の理由を調べたら、
 *   ★ **10 件とも 2026-05-25 に投入されたデモデータ**だった (実運用は 0 件)。
 *     利用者番号が A002〜A009 / B002 / B003 の連番
 *     content が 10 行で **3 種類しかない** (同じ文面を使い回している)
 *     実績 0 件 / 事業所割当 0 件 (= 請求にも一覧にも出ない)
 *   → 「件数が少ない」を「使われていない」と読む前に、
 *     ★ **その件数が本物か**を確かめる必要がある。
 *
 * ── 何を疑うか ────────────────────────────────────────────────────────────
 *   ① 利用者番号が A/B + 3 桁          デモの連番
 *   ② 氏名に「見本」                   ほのぼの側の動作確認用 (PDF 取込で入る)
 *   ③ 氏名が test / テスト             開発用
 *   ④ 利用者番号が Z[CPJKLG] で始まる    ★ 検証セッションのサンプル (SAMPLE_DATA_PROTOCOL)
 *      → **残っていたら撤去し忘れ**。担当セッションに知らせる
 *   ⑤ 利用者番号が同じ数字の反復        1111111111 等
 *   ⑥ 氏名が記号で始まる                ほのぼのの予定枠ダミー (★ ◆ ◎ ● ■)
 *
 * ⚠ **消さない。**この script は数えるだけ。撤去は持ち主が判断する。
 */
import { readFileSync } from "node:fs";
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

type C = { id: string; name: string | null; user_number: string | null; created_at: string | null; status: string | null };
const cl = await all<C>("clients", "id, name, user_number, created_at, status", "id");
console.log(`【分母】clients ${cl.length} 名`);

const num = (c: C) => String(c.user_number ?? "");
const nm = (c: C) => String(c.name ?? "").trim();
const PATTERNS: [string, (c: C) => boolean][] = [
  ["利用者番号が A/B + 3 桁 (デモ連番)", (c) => /^[AB]\d{3}$/.test(num(c))],
  ["氏名に「見本」 (ほのぼのの動作確認用)", (c) => nm(c).includes("見本")],
  ["氏名が test / テスト", (c) => /^(test|テスト)/i.test(nm(c))],
  ["★ 検証サンプル Z[CPJKLG] (撤去し忘れ?)", (c) => /^Z[CPJKLG]/.test(num(c))],
  ["利用者番号が同じ数字の反復", (c) => /^(\d)\1{6,}$/.test(num(c))],
  ["氏名が記号で始まる (ほのぼのの予定枠)", (c) => /^[★◆◎●■☆▲]/.test(nm(c))],
];

const hit = new Set<string>();
for (const [label, f] of PATTERNS) {
  const rows = cl.filter(f);
  for (const r of rows) hit.add(r.id);
  console.log(`\n  ${rows.length ? "★ " : "OK "}${label} — ${rows.length} 名`);
  for (const r of rows.slice(0, 8)) {
    console.log(`      ${nm(r).padEnd(24)} 利番 ${num(r).padEnd(12)} 作成 ${(r.created_at ?? "").slice(0, 10)} ${r.status}`);
  }
  if (rows.length > 8) console.log(`      … 他 ${rows.length - 8} 名`);
}

const ids = [...hit];
console.log(`\n══ ★ 疑わしい利用者 のべ ${ids.length} 名 にぶら下がるデータ ══`);
for (const [t, col] of [
  ["kaigo_visit_schedule", "user_id"],
  ["client_office_assignments", "client_id"],
  ["client_insurance_records", "client_id"],
  ["client_kohi_records", "client_id"],
  ["kaigo_report_documents", "user_id"],
  ["kaigo_assessments", "user_id"],
  ["kaigo_support_records", "user_id"],
] as [string, string][]) {
  let n = 0;
  for (let i = 0; i < ids.length; i += 150) {
    const { count, error } = await sb.from(t).select("*", { count: "exact", head: true }).in(col, ids.slice(i, i + 150));
    if (error) { console.log(`  ${t}: ERROR ${error.message}`); n = -1; break; }
    n += count ?? 0;
  }
  if (n >= 0) console.log(`  ${n ? "★ " : "OK "}${t.padEnd(28)} ${n} 行`);
}

console.log(`\n⚠ **消さない。**この script は数えるだけ。撤去は持ち主が判断する。`);
console.log(`⚠ Z[CPJKLG] が出たら **検証セッションのサンプルが残っている**。担当に知らせること`);
console.log(`  (SAMPLE_DATA_PROTOCOL: 検証が終わったら撤去し 0 件を確認する)。`);
console.log(`⚠ 「件数が少ない = 使われていない」と読む前に、★ **その件数が本物か**を確かめる。`);
console.log(`  課題整理総括表 / 評価表 は 10 件あるが **全部デモ** (content が 3 種類の使い回し)。`);
console.log(`  実運用は **0 件**。`);
