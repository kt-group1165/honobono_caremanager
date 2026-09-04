/**
 * ★ ほのぼのが「何分の訪問に どのコードを使ったか」を実データから読む (READ ONLY)
 *
 *   npx tsx scripts/honobono-tier-boundaries.mts
 *   MONTHS_FROM=2026-06-01 MONTHS_TO=2026-07-31 npx tsx ...
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   ★ ほのぼのを置き換えると、★ サービスコードを 当方が決めることになる。
 *   いまは ほのぼのが決めたコードを 取り込んでいるだけなので、
 *   ★ 「何分なら どの段か」の規則を 当方は持っていない。
 *
 *   ★ 実績には ほのぼのが決めたコードと 算定時刻の両方が入っている。
 *   ★ 突き合わせれば ほのぼのの規則を 実データから読み取れる。
 *
 * ⚠ ★ これは「告示の規則」ではなく「★ ほのぼのが実際にやったこと」です。
 *   ★ 告示と食い違う可能性があります。移行の設計に使うときは 告示で裏を取ること。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env: Record<string, string> = {};
for (const l of readFileSync(join(__dirname, "..", ".env.local"), "utf8").split(/\r?\n/)) {
  const i = l.indexOf("=");
  if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY がありません。中止します。");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const FROM = process.env.MONTHS_FROM ?? "2026-06-01";
const TO = process.env.MONTHS_TO ?? "2026-07-31";

type Row = { service_type: string | null; start_time: string | null; end_time: string | null; system: string | null };

const toMin = (t: string | null): number | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const rows: Row[] = [];
for (let off = 0; ; off += 1000) {
  const { data, error } = await sb
    .from("kaigo_visit_schedule")
    .select("service_type, start_time, end_time, system")
    .eq("status", "completed").eq("system", "介護")
    .gte("visit_date", FROM).lte("visit_date", TO)
    .order("id", { ascending: true }).range(off, off + 999);
  if (error) throw new Error(`取得失敗: ${error.message}`);
  const r = (data ?? []) as unknown as Row[];
  rows.push(...r);
  if (r.length < 1000) break;
}

console.log(`ほのぼのの段の境界 — ${FROM} 〜 ${TO} / 介護・completed ★ ${rows.length} 行\n`);
if (rows.length === 0) { console.log("★ FAIL 0 行です。"); process.exit(1); }

type Stat = { n: number; min: number; max: number; hist: Map<number, number> };
const stat = new Map<string, Stat>();
let skipped = 0;
for (const r of rows) {
  const name = String(r.service_type ?? "").normalize("NFKC");
  // ★ 身体介護の単独型 / 身体N生活M / 生活援助 を それぞれ 1 つの族として見る
  //   ★ 名前の装飾 (・夜 / ・深 / ・2人 / ・虐防 等) は落とす。段の判定だけを見たいので
  const m =
    /^(身体介護0?\d)(?!.*生活)/.exec(name) ??
    /^(身体\d生活\d)/.exec(name) ??
    /^(生活援助\d)/.exec(name);
  if (!m) { skipped++; continue; }
  const s = toMin(r.start_time), e0 = toMin(r.end_time);
  if (s == null || e0 == null) { skipped++; continue; }
  const d = (e0 <= s ? e0 + 1440 : e0) - s;
  let x = stat.get(m[1]);
  if (!x) { x = { n: 0, min: Infinity, max: 0, hist: new Map() }; stat.set(m[1], x); }
  x.n++; x.min = Math.min(x.min, d); x.max = Math.max(x.max, d);
  x.hist.set(d, (x.hist.get(d) ?? 0) + 1);
}

console.log("★ ほのぼのが 各コードを 何分の訪問に使ったか");
const keys = [...stat.keys()].sort();
for (const k of keys) {
  const v = stat.get(k)!;
  const top = [...v.hist].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([d, c]) => `${d}分×${c}`).join(" ");
  console.log(`  ${k.padEnd(10)} ${String(v.n).padStart(6)}件  ${String(v.min).padStart(3)}〜${String(v.max).padStart(3)}分   ${top}`);
}

// ★ 同じ所要時間が 複数の段に割り当てられていないか (= 時間だけでは決まらない証拠)
console.log("\n★ 同じ所要時間が 2 つ以上の段に使われているもの");
const byDur = new Map<number, Map<string, number>>();
for (const [k, v] of stat) for (const [d, c] of v.hist) {
  let m2 = byDur.get(d); if (!m2) { m2 = new Map(); byDur.set(d, m2); }
  m2.set(k, c);
}
let amb = 0;
for (const [d, m2] of [...byDur].sort((a, b) => a[0] - b[0])) {
  if (m2.size < 2) continue;
  amb++;
  console.log(`  ${String(d).padStart(3)}分 → ${[...m2].map(([k, c]) => `${k}(${c}件)`).join(" / ")}`);
}
if (amb === 0) console.log("  (なし)");
else {
  // ★ 「何通りあるか」より ★ 「何件が曖昧な帯にあるか」のほうが規模を表す
  let ambRows = 0, totalRows = 0, minority = 0;
  for (const [, m2] of byDur) {
    const n = [...m2.values()].reduce((a, b) => a + b, 0);
    totalRows += n;
    if (m2.size >= 2) ambRows += n;
    // ★ 少数側 = 所要時間だけで決める規則にしたとき ★ 実際に間違える件数
    if (m2.size >= 2) minority += n - Math.max(...m2.values());
  }
  console.log(`\n  ★ ${amb} 通りの所要時間が 複数の段にまたがっています。`);
  console.log(`  ★ その帯にある実績は ${ambRows} / ${totalRows} 件 = ${((ambRows / totalRows) * 100).toFixed(1)}%`);
  console.log(`  ★ うち 少数側 (= 所要時間だけで決めると 実際に間違える件数) は ${minority} 件 = ${((minority / totalRows) * 100).toFixed(2)}%`);
  console.log("  ⚠ ★ 見出しは 少数側の方です。「曖昧な帯に 94% がある」は");
  console.log("     ★ 巨大な帯に 外れ値が 1 件混じるだけで そうなるので、規模を表しません。");
}
console.log("  ⚠ ★ 所要時間だけでは 段が決まらない、ということです。");
console.log("     ★ 足りない入力は ★ 身体/生活の分単位の内訳 と ★ 2人派遣 の 2 つ。");
console.log("     ★ 2人派遣は staff_id_2 が 0 件で、サービス名の文字列にしか無い");
console.log("       (check:coverage-duration で実測: 名前に「2人」を含む行 1,125 / 39,613)。");
console.log("     ★ ほのぼのを置き換えるとき、★ この差を埋める入力が別に要ります。");

console.log(`\n⚠ 対象外 (身体N生活M・生活援助・その他) として飛ばした行: ${skipped}`);
console.log("⚠ ★ これは「告示の規則」ではなく ★「ほのぼのが実際にやったこと」です。");
console.log("   ★ 移行の設計に使うときは 告示で裏を取ること。");
