/**
 * ケアプラン第2表の移行データを点検する (READ ONLY)
 *
 *   npx tsx scripts/careplan2-migration-check.mts
 *
 * 出どころは ほのぼの「計画書（2）A様式」CSV (`ケアプラン/全/KAIGO1_H31.CSV`)。
 * **最新の 1 件だけ**取り込む方針 (2026-08-30 user 確定) なので、
 * 件数が CSV より少ないのは正常 (CSV 46,228 計画 / 8,170 名 → DB 2,803 / 2,800 名)。
 * ★ 見るのは **件数ではなく中身**。
 *
 * ── ★ 見つかったこと (2026-09-03) ────────────────────────────────────────
 *   ① 期間の列 6 本 (long_term_start/end, short_term_start/end, service_start/end) が
 *      **すべて 0%**。実際の期間は `frequency` の文字列に **頻度と連結**されている
 *      (「毎日 R8/4/1～R8/9/30」)。
 *   ② その結果 第2表の印字がおかしい。`reports-content.tsx:652`
 *        const period = (a, b) => a || b ? `${fmtReiwa(a)}〜${fmtReiwa(b)}` : planPeriod;
 *      → 6 本とも null なので **全部 計画全体の期間にフォールバック**する。
 *        サービス期間・長期目標期間・短期目標期間が **全部同じ**になり、
 *        頻度欄には **頻度と期間が混ざって**出る。第2表は法定様式なので実害がある。
 *   ③ ★ **frequency から復元できるのは「サービス期間」だけ** (93%)。
 *      ⚠ 最初「93% は復元できる」と書いたが **誤り**だった。復元先は 3 対 6 本あり、
 *        1 つの期間を 6 本に入れると **長期目標の期間が 87% の行で誤りになる**。
 *
 * ── ★ CSV には期間が 3 つ別々の列である (2026-09-03 実測) ────────────────
 *     18 期間            99%  ← 取込はこれだけを frequency に連結
 *     19 長期目標(期間)   70%  ← ★ 取込が **1 度も読んでいない** (r[19] はコードに無い)
 *     20 短期目標(期間)   87%  ← ★ 同上
 *     22-27 構造化日付     0%  ← 取込はここを読んでいるが空
 *
 *   3 つとも値がある 182,334 行での一致率:
 *     3 つとも同じ 13% / 期間==長期 ★ 13% / 期間==短期 95% / 長期==短期 13%
 *   → **長期目標の期間はサービス期間と 87% 違う**。
 *   → backfill は **CSV を読み直す**しかない。frequency からは service_start/end だけ。
 *      ★ long_term_start/end は **DB のどこにも無い**。
 *
 * ── ⚠ 取込のせいではないもの (元 CSV がそうなっている) ──────────────────
 *   ・CSV の構造化された日付列 (22-27) は **100% 空**。テキストしか無い。
 *   ・CSV の 頻度 自体が連結されていることがある
 *     (「週1回(月曜日)週1回(木曜日)週1回(金曜日)」)。18,391 種類。
 *   ・ありえない日付 (R8/9/31 = 9 月 31 日 / R7.12.91) が **元データに存在**する。
 *   ★ 「連結されている」を見つけたとき、まず CSV を見て **どちらの責任か**を分けた。
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

type Svc = {
  id: string; care_plan_id: string; service_type: string | null; service_content: string | null;
  frequency: string | null; provider: string | null; needs: string | null;
  long_term_goal: string | null; long_term_start: string | null; long_term_end: string | null;
  short_term_goal: string | null; short_term_start: string | null; short_term_end: string | null;
  service_start: string | null; service_end: string | null; display_order: number | null;
};

const s = await all<Svc>("kaigo_care_plan_services",
  "id, care_plan_id, service_type, service_content, frequency, provider, needs, long_term_goal, long_term_start, long_term_end, short_term_goal, short_term_start, short_term_end, service_start, service_end, display_order", "id");
const plans = await all<{ id: string; user_id: string; start_date: string | null; end_date: string | null }>(
  "kaigo_care_plans", "id, user_id, start_date, end_date", "id");

const n = s.length;
console.log(`══ 分母 ══`);
console.log(`  kaigo_care_plans          ${plans.length} 件 / 利用者 ${new Set(plans.map((p) => p.user_id)).size} 名`);
console.log(`  kaigo_care_plan_services  ${n} 行`);
console.log(`  ⚠ CSV は 46,228 計画 / 8,170 名。**最新 1 件だけ**取り込む方針なので差は正常。`);

console.log(`\n══ 列の充足率 ══`);
const filled = (f: keyof Svc) => s.filter((r) => r[f] != null && String(r[f]).trim() !== "").length;
for (const f of ["service_type", "service_content", "frequency", "provider", "needs",
  "long_term_goal", "short_term_goal", "display_order",
  "long_term_start", "long_term_end", "short_term_start", "short_term_end", "service_start", "service_end"] as (keyof Svc)[]) {
  const c = filled(f);
  const zero = c === 0;
  console.log(`  ${zero ? "★ " : "  "}${String(f).padEnd(18)} ${String(c).padStart(6)} (${Math.round(c * 100 / n)}%)`);
}
console.log(`  ★ 期間の列 6 本がすべて 0% → 第2表の期間欄は **全部 計画全体の期間**にフォールバックする`);
console.log(`     (reports-content.tsx:652 の period() は両方 null なら planPeriod を返す)`);

// ── frequency に期間が混ざっているか / 復元できるか ──
const RE = /([RH])\s*(\d{1,2})\s*[./]\s*(\d{1,2})\s*[./]\s*(\d{1,2})\s*[～~]\s*([RH])?\s*(\d{1,2})\s*[./]\s*(\d{1,2})\s*[./]\s*(\d{1,2})/;
const toYmd = (era: string, y: string, m: string, d: string) => {
  const Y = (era === "H" ? 1988 : 2018) + Number(y);
  const dt = new Date(Y, Number(m) - 1, Number(d));
  // ★ ありえない日付 (9/31 等) は Date が繰り上げるので、戻して一致を見る
  if (dt.getMonth() !== Number(m) - 1 || dt.getDate() !== Number(d)) return null;
  return `${Y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};
let hit = 0, ok = 0, invalid = 0;
const badEx: string[] = [];
for (const r of s) {
  const m = RE.exec(r.frequency ?? "");
  if (!m) continue;
  hit++;
  const a = toYmd(m[1], m[2], m[3], m[4]);
  const b = toYmd(m[5] ?? m[1], m[6], m[7], m[8]);
  if (a && b) ok++;
  else { invalid++; if (badEx.length < 5) badEx.push(r.frequency ?? ""); }
}
console.log(`\n══ frequency に混ざった期間 ══`);
console.log(`  ★ 期間が混ざっている            ${hit} 行 (${Math.round(hit * 100 / n)}%)`);
console.log(`     └ 実在する日付として復元できる  ${ok} 行  ← ★ ただし **サービス期間だけ**`);
console.log(`     └ ★ ありえない日付を含む      ${invalid} 行  ← **元データの誤り**`);
for (const e of badEx) console.log(`        ${JSON.stringify(e)}`);
console.log(`  期間が見つからない                ${n - hit} 行`);

// ── 孤児 / 紐付け ──
const planIds = new Set(plans.map((p) => p.id));
const orphan = s.filter((r) => !planIds.has(r.care_plan_id)).length;
console.log(`\n══ 紐付け ══`);
console.log(`  ${orphan ? "★ " : "OK "}存在しない計画を指すサービス行  ${orphan}`);
const withSvc = new Set(s.map((r) => r.care_plan_id));
console.log(`  ${plans.length - withSvc.size ? "★ " : "OK "}サービス行が 1 つも無い計画    ${plans.length - withSvc.size}`);
const noPeriodPlan = plans.filter((p) => !p.start_date || !p.end_date).length;
console.log(`  ${noPeriodPlan ? "★ " : "OK "}計画の期間 (start/end) が欠けている ${noPeriodPlan}`);
console.log(`     ⚠ 期間欄はここにフォールバックするので、欠けると **期間が空で印字**される`);

console.log(`\n⚠ backfill (frequency から 6 本の日付列を復元し、頻度から期間を外す) は`);
console.log(`  14,774 行の書き換えになるので **user 判断**。この script は読むだけ。`);
