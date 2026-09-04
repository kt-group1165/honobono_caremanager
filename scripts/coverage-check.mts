/**
 * 実データが 因子の組合せを **どこまで覆っているか** を制度ごとに測る (READ ONLY)
 *
 *   npx tsx scripts/coverage-check.mts
 *   SYSTEMS=kaigo,shogai MONTHS=2026-06 npx tsx scripts/coverage-check.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   「実データだけだと網羅性がない」は感覚では言える。★ 数字にする。
 *   覆えている値・覆えている 2 因子ペアを出し、足りないぶんが
 *   ★ サンプルで埋めるべき量になる。
 *
 * ── 分母は scripts/_factors.mts に一本化した (2026-09-04) ────────────────
 *   それ以前は sample-matrix (9因子474ペア) と このファイル (8因子285ペア) が
 *   ★ 別々に因子を定義していて、分母が違う数字を並べて説明していた。
 *   いまは **同じ定義・同じ pairKeysFor()** から分母を作るので、
 *   sample-matrix が出す「全ペア」と ここの「全ペア」は必ず一致する。
 *
 * ⚠ 測れない因子 (所要時間 等) は ★ 測ったことにしない。
 *   「全ペア」と「測定可能ペア」の 2 つを出し、率は測定可能ぶんで出す。
 *
 * ⚠ ★ 0 件は偽陰性を疑う。実行の最初に **負のコントロール** (合成行) を流し、
 *   measure が動くことを確かめてから実データを測る。
 *   「実データに無い」のか「読み取りが壊れている」のかを区別するため
 *   (VERIFICATION_RULES 3-9 / 2章)。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { aggregateMonthlyVisitSeikyu } from "@/lib/visit-seikyu/aggregate";
import { aggregateMonthlyShogaiSeikyu } from "@/lib/shogai-seikyu/aggregate";
import type { UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";
import type { SougouSeikyuRow } from "@/lib/visit-seikyu/aggregate-sougou";
import type { ShogaiSeikyuRow } from "@/lib/shogai-seikyu/aggregate";
import {
  KAIGO_FACTORS, SOUGOU_FACTORS, SHOGAI_FACTORS, KYOTAKU_FACTORS,
  pairKeysFor, toValues,
  type FactorSet, type KyotakuClaimRow,
} from "./_factors.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env: Record<string, string> = {};
for (const l of readFileSync(join(__dirname, "..", ".env.local"), "utf8").split(/\r?\n/)) {
  const i = l.indexOf("=");
  if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
// 1-2 / 2章⑦: anon で回すと RLS で 0 行になり「該当なし」に化ける
if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY がありません。中止します。");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const MONTHS = (process.env.MONTHS ?? "2026-06,2026-07").split(",").map((s) => s.trim());
const WANT = (process.env.SYSTEMS ?? "kaigo,sougou,shogai,kyotaku").split(",").map((s) => s.trim());
const want = (k: string) => WANT.includes(k);

let failed = false;

/* ── 負のコントロール ─────────────────────────────────────────────────── */

/** 合成行を流して measure が動くことを確かめる。★ 壊れていたら実データを測る前に落とす */
function runProbes<R>(set: FactorSet<R>): boolean {
  let ok = true;
  const byName = new Map(set.factors.map((f) => [f.name, f]));
  const measurable = set.factors.filter((f) => f.measure).map((f) => f.name);
  const seenInProbe = new Set<string>();
  for (const p of set.probes) {
    for (const [name, expect] of Object.entries(p.expect)) {
      const f = byName.get(name);
      if (!f) { console.log(`   ★ FAIL probe「${p.label}」: 因子「${name}」が定義にありません`); ok = false; continue; }
      if (!f.measure) { console.log(`   ★ FAIL probe「${p.label}」: 因子「${name}」は未測定なのに expect があります`); ok = false; continue; }
      const got = toValues(f.measure(p.row)).slice().sort();
      const exp = expect.slice().sort();
      if (got.join("|") !== exp.join("|")) {
        console.log(`   ★ FAIL probe「${p.label}」 ${name}: 期待 [${exp.join(", ")}] / 実際 [${got.join(", ")}]`);
        ok = false;
      }
      seenInProbe.add(name);
    }
  }
  const noProbe = measurable.filter((n) => !seenInProbe.has(n));
  console.log(`   負のコントロール: ${set.probes.length} 行 × ${seenInProbe.size} 因子 ${ok ? "OK" : "★ FAIL"}`
    + (noProbe.length ? `   ⚠ probe が無い因子 ${noProbe.length}: ${noProbe.join(" / ")}` : ""));
  return ok;
}

/* ── 計測 ────────────────────────────────────────────────────────────── */

function report<R>(set: FactorSet<R>, rows: R[]): void {
  const F = set.factors;
  const allPairs = pairKeysFor(set);
  const measurableIdx = F.map((f, i) => (f.measure ? i : -1)).filter((i) => i >= 0);
  const measurablePairs = allPairs.filter((p) => {
    const m = /^(\d+):.*\|(\d+):/.exec(p);
    return !!m && measurableIdx.includes(+m[1]) && measurableIdx.includes(+m[2]);
  });

  const seenValue = F.map(() => new Set<string>());
  const seenPair = new Set<string>();
  const unread = F.map(() => 0);
  const outOfList = new Map<string, number>();

  for (const r of rows) {
    const vals: string[][] = F.map((f, i) => {
      if (!f.measure) return [];
      const got = toValues(f.measure(r));
      if (got.length === 0) { unread[i]++; return []; }
      const keep = got.filter((v) => {
        if (f.values.includes(v)) return true;
        const k = `${f.name}: ${v}`;
        outOfList.set(k, (outOfList.get(k) ?? 0) + 1);
        return false;
      });
      if (keep.length === 0) unread[i]++;
      return keep;
    });
    for (let i = 0; i < F.length; i++) for (const v of vals[i]) seenValue[i].add(v);
    for (let i = 0; i < F.length; i++)
      for (let j = i + 1; j < F.length; j++)
        for (const a of vals[i]) for (const b of vals[j]) seenPair.add(`${i}:${a}|${j}:${b}`);
  }

  console.log(`\n━━ ${set.system}`);
  console.log(`   取得元: ${set.source}`);
  if (set.note) console.log(`   ⚠ ${set.note}`);
  console.log(`   ★ 行数 ${rows.length}  / 月 ${MONTHS.join(" ")}`);
  if (rows.length === 0) {
    // 1-2: 分母 0 で合格判定を出さない
    console.log("   ★ FAIL 0 行です。網羅率は測れません (合格ではなく ★ 未測定)。");
    failed = true;
    return;
  }

  const unmeasurable = F.filter((f) => !f.measure);
  console.log(`   因子 ${F.length} 個 / ★ 全ペア ${allPairs.length} 組 (= sample-matrix と同じ分母)`);
  console.log(`     うち 測定可能 ${measurablePairs.length} 組 / ★ 未測定因子を含む ${allPairs.length - measurablePairs.length} 組`
    + (unmeasurable.length ? `  (未測定: ${unmeasurable.map((f) => f.name).join(" / ")})` : ""));

  console.log("\n   ── 値の網羅 (実データに 1 件でも出るか)");
  for (let i = 0; i < F.length; i++) {
    const f = F[i];
    if (!f.measure) { console.log(`   -- ${f.name.padEnd(12)} ★ 未測定 (${f.values.length} 値)`); continue; }
    const miss = f.values.filter((v) => !seenValue[i].has(v));
    const mark = miss.length === 0 ? "   " : "★  ";
    console.log(`   ${mark}${f.name.padEnd(12)} ${f.values.length - miss.length}/${f.values.length}`
      + (miss.length ? `   ★ 出ない値: ${miss.join(" / ")}` : "")
      + (unread[i] ? `   (読めない行 ${unread[i]})` : ""));
  }
  if (outOfList.size) {
    console.log("\n   ⚠ 値リストに無い値が実データに出た (因子定義の見直し候補)");
    for (const [k, v] of [...outOfList].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`      ${k}  ${v} 行`);
  }

  const covered = measurablePairs.filter((p) => seenPair.has(p));
  const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
  console.log(`\n   ── 2 因子ペアの網羅`);
  console.log(`      測定可能ぶん  ${covered.length} / ${measurablePairs.length} = ★ ${pct(covered.length, measurablePairs.length)}`);
  console.log(`      全ペア基準    ${covered.length} / ${allPairs.length} = ${pct(covered.length, allPairs.length)}   ★ 未測定ぶんは覆えたと数えない`);
  console.log(`      ★ 実データに一度も出ない組合せ: ${measurablePairs.length - covered.length} 組 (測定可能ぶん)`);

  const gap = new Map<string, number>();
  for (const p of measurablePairs) {
    if (seenPair.has(p)) continue;
    const m = /^(\d+):.*\|(\d+):/.exec(p);
    if (!m) continue;
    const k = `${F[+m[1]].name} × ${F[+m[2]].name}`;
    gap.set(k, (gap.get(k) ?? 0) + 1);
  }
  if (gap.size) {
    console.log("\n   ── 薄いところ (出ないペアが多い因子の組)");
    for (const [k, v] of [...gap].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`      ${k.padEnd(34)} ${v} 組`);
  }
}

/* ── 実データの取得 ──────────────────────────────────────────────────── */

async function fetchKyotakuRows(): Promise<KyotakuClaimRow[]> {
  const cols = "billing_month,care_support_code,care_support_name,tokutei_kassan_type,unit_price,"
    + "initial_addition,hospital_coordination,discharge_addition,discharge_type,medical_coordination,"
    + "medical_coop_kassan,terminal_care,emergency_conference,unei_kijun_gensan,bcp_not_prepared,"
    + "abuse_prevention_not_implemented,shoguu_kaizen_code,notes";
  const out: KyotakuClaimRow[] = [];
  // 2章⑤: PostgREST は order 無しだと行が抜ける。range で明示的に回す
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb
      .from("kaigo_care_support_claims")
      .select(cols)
      .in("billing_month", MONTHS)
      .order("id", { ascending: true })
      .range(off, off + 999);
    if (error) throw new Error(`居宅レセプトの取得に失敗: ${error.message}`);
    out.push(...((data ?? []) as unknown as KyotakuClaimRow[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(`実データの網羅率 — 月 ${MONTHS.join(" ")} / 制度 ${WANT.join(" ")}   (READ ONLY)\n`);

  console.log("── 負のコントロール (measure が動くことの確認。実データを測る前に)");
  const sets: { key: string; run: () => boolean }[] = [
    { key: "kaigo", run: () => runProbes(KAIGO_FACTORS) },
    { key: "sougou", run: () => runProbes(SOUGOU_FACTORS) },
    { key: "shogai", run: () => runProbes(SHOGAI_FACTORS) },
    { key: "kyotaku", run: () => runProbes(KYOTAKU_FACTORS) },
  ];
  for (const s of sets) {
    if (!want(s.key)) continue;
    process.stdout.write(`   ${s.key}\n`);
    if (!s.run()) failed = true;
  }
  if (failed) {
    console.log("\n★ FAIL 読み取り (measure) が壊れています。網羅率を測っても意味がないので中止します。");
    process.exit(1);
  }

  const kaigoRows: UserSeikyuRow[] = [];
  const sougouRows: SougouSeikyuRow[] = [];
  const shogaiRows: ShogaiSeikyuRow[] = [];

  const needVisit = want("kaigo") || want("sougou");
  if (needVisit || want("shogai")) {
    const { data: offices, error } = await sb
      .from("offices").select("id, name, tenant_id, unit_price, applied_formula_codes, service_type").order("name");
    if (error) throw new Error(`offices 取得に失敗: ${error.message}`);
    const targets = (offices ?? []).filter(
      (o) => /訪問介護|ヘルパー/.test(String(o.name)) || String(o.service_type ?? "").includes("訪問介護"),
    );
    if (targets.length === 0) throw new Error("対象事業所が 0 件です (絞り込みを疑ってください)");
    console.log(`\n訪問介護 事業所 ${targets.length} 件 × 月 ${MONTHS.length} で集計します…`);
    for (const o of targets) {
      for (const m of MONTHS) {
        const [y, mo] = m.split("-").map(Number);
        if (needVisit) {
          try {
            const res = await aggregateMonthlyVisitSeikyu(sb, {
              officeId: o.id as string, tenantId: o.tenant_id as string, year: y, month: mo,
              unitPrice: (o.unit_price as number) ?? undefined,
              appliedFormulaCodes: (o.applied_formula_codes as string[]) ?? [],
            });
            if (want("kaigo")) kaigoRows.push(...res.rows);
            if (want("sougou")) sougouRows.push(...((res.sougouRows ?? []) as SougouSeikyuRow[]));
          } catch (e) {
            // ★ 握りつぶさない。落ちた事業所×月が分かるように出す
            console.log(`   ⚠ ${o.name} ${m}: 介護の集計に失敗 — ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (want("shogai")) {
          try {
            const sres = await aggregateMonthlyShogaiSeikyu(sb, { year: y, month: mo, officeId: o.id as string });
            shogaiRows.push(...sres.rows);
          } catch (e) {
            console.log(`   ⚠ ${o.name} ${m}: 障害の集計に失敗 — ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }
  }

  if (want("kaigo")) report(KAIGO_FACTORS, kaigoRows);
  if (want("sougou")) report(SOUGOU_FACTORS, sougouRows);
  if (want("shogai")) report(SHOGAI_FACTORS, shogaiRows);
  if (want("kyotaku")) report(KYOTAKU_FACTORS, await fetchKyotakuRows());

  console.log("\n⚠ この数字が言っていないこと");
  console.log("   ・3 因子でしか出ない相互作用は ★ 見ていない (pairwise の限界)");
  console.log("   ・未測定の因子を含むペアは分母から外している (率を高く見せないため)");
  console.log("   ・「値が出た」は ★ 正しく計算されたという意味ではない。金額の検算は npm run check:invariant");
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
