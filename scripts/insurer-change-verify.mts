/**
 * 月途中の保険者変更 (転居) によるレセプト分割 の検証
 *
 *   npx tsx scripts/insurer-change-verify.mts
 *
 * migrations/seed_fake_insurer_change_test.mjs で投入したテスト事業所 (2026-10) を
 * aggregateMonthlyVisitSeikyu / buildKokuhoDensou に通し、**手計算した期待値**と突合する。
 *
 * 背景: 居宅で「転居月は 1 人が 2 レセプトなのに (user_id, billing_month) が一意で、
 * 後から取り込んだほうが**黙って上書き**していた」事故があった (加藤綾子 2026-06)。
 * 同じ型の取りこぼしが訪問介護・障害に無いかを見る。
 *
 * ── 手計算の根拠 ────────────────────────────────────────────
 * 身体介護３ 567単位 / 単価 11.05 円 / 1割負担。
 *   前半 10回 = 5670 単位  総額 floor(62653.5)  = 62653  保険 floor(56387.7)  = 56387
 *   後半  8回 = 4536 単位  総額 floor(50122.8)  = 50122  保険 floor(45109.8)  = 45109
 *   通し 18回 = 10206 単位 総額 floor(112776.3) = 112776 保険 floor(101498.4) = 101498
 *
 * ★ 分割すると floor が 2 回効くので 62653 + 50122 = 112775 で、
 *   分割なしの 112776 より **1 円少ない**。金額でも「本当に分割されたか」が判る。
 * ────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { aggregateMonthlyVisitSeikyu, type UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";
// ⚠ 障害は aggregateMonthlyVisitSeikyu の戻り値に含まれない (返すのは rows と sougouRows のみ)。
//   別関数なので直接呼ぶ。ここを間違えると「障害 0 件」の偽陰性になる。
import { aggregateMonthlyShogaiSeikyu } from "@/lib/shogai-seikyu/aggregate";
import { buildKokuhoDensou, type DensouRow } from "@/lib/kokuho-densou/build";

const META = JSON.parse(
  readFileSync(new URL("../migrations/_fake_insurer_change_test_meta.json", import.meta.url), "utf8"),
) as {
  marker: string; month: string; officeId: string; unitPrice: number; tenantId: string;
  firstHalf: number[]; secondHalf: number[];
  cases: { tag: string; clientId: string; system: string; certs: string; shogai: string | null; memo: string }[];
};

const env: Record<string, string> = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
  if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const FIRST = { units: 5670, total: 62653, insurance: 56387 };
const SECOND = { units: 4536, total: 50122, insurance: 45109 };
const WHOLE = { units: 10206, total: 112776, insurance: 101498 };

interface ExpSeg { insurer: string; insured: string; units: number; total: number; insurance: number }
const EXPECTED: Record<string, ExpSeg[]> = {
  // ★本命: 千葉市 (前半) / 船橋市 (後半) の 2 レセプト
  S01: [
    { insurer: "121012", insured: "9930000101", ...FIRST },
    { insurer: "122011", insured: "9930000102", ...SECOND },
  ],
  // 対照: 分割なし 1 レセプト (合計が S01 より 1 円多い)
  S02: [{ insurer: "121012", insured: "9930000201", ...WHOLE }],
  // 被保険者番号だけ変わるケースも分割される
  S03: [
    { insurer: "121012", insured: "9930000301", ...FIRST },
    { insurer: "121012", insured: "9930000302", ...SECOND },
  ],
  // 境界日が判定不能 → 分割せず月末時点の認定 1 本
  S04: [{ insurer: "122011", insured: "9930000402", ...WHOLE }],
};

async function main() {
  const fails: string[] = [];
  const tagOf = new Map(META.cases.map((c) => [c.clientId, c.tag]));
  const [y, m] = META.month.split("-").map(Number);

  const res = await aggregateMonthlyVisitSeikyu(sb, {
    officeId: META.officeId, tenantId: META.tenantId, year: y, month: m,
    unitPrice: META.unitPrice, appliedFormulaCodes: [],
  });

  console.log(`対象月 ${META.month} / 事業所 ${META.officeId}`);
  console.log(`介護の集計行 ${res.rows.length} 件 (障害は別関数 aggregateMonthlyShogaiSeikyu — ④ で見る)\n`);

  // ── ① 介護: 保険者ごとにレセプトが立つか ────────────────────
  console.log("=== ① 介護保険 — 保険者変更のレセプト分割 ===");
  const byTag = new Map<string, UserSeikyuRow[]>();
  for (const r of res.rows) {
    const tag = tagOf.get(r.user_id) ?? "?";
    const list = byTag.get(tag) ?? [];
    list.push(r);
    byTag.set(tag, list);
  }
  for (const tag of Object.keys(EXPECTED)) {
    const exp = EXPECTED[tag];
    const got = (byTag.get(tag) ?? []).sort((a, b) => (a.segmentIndex ?? 0) - (b.segmentIndex ?? 0));
    const diffs: string[] = [];
    if (got.length !== exp.length) {
      diffs.push(`レセプト数 実測 ${got.length} ≠ 期待 ${exp.length}${got.length < exp.length ? " (★片方が消えている = 黙って上書きの型)" : ""}`);
    } else {
      for (let i = 0; i < exp.length; i++) {
        const e = exp[i], g = got[i];
        if ((g.insurer_number ?? "") !== e.insurer) diffs.push(`[${i}] 保険者 ${g.insurer_number} ≠ ${e.insurer}`);
        if ((g.insured_number ?? "") !== e.insured) diffs.push(`[${i}] 被保番 ${g.insured_number} ≠ ${e.insured}`);
        if (g.totalUnits !== e.units) diffs.push(`[${i}] 単位 ${g.totalUnits} ≠ ${e.units}`);
        if (g.totalAmount !== e.total) diffs.push(`[${i}] 総額 ${g.totalAmount} ≠ ${e.total}`);
        if (g.insuranceAmount !== e.insurance) diffs.push(`[${i}] 保険 ${g.insuranceAmount} ≠ ${e.insurance}`);
      }
    }
    const label = got.map((g) => `${g.insurer_number}/${g.insured_number} ${g.totalUnits}単位 ¥${g.totalAmount}${g.segmentCount ? ` [${(g.segmentIndex ?? 0) + 1}/${g.segmentCount} ${g.periodFrom}〜${g.periodTo}]` : " [分割なし]"}`).join("\n           ");
    if (diffs.length === 0) console.log(`  ✓ ${tag}  ${label}`);
    else { console.log(`  ✗ ${tag}  ${label}`); for (const d of diffs) console.log(`       ${d}`); fails.push(`${tag}: ${diffs.join(" / ")}`); }
  }

  // ★ 実績が 1 件も落ちていないこと (分母つき)
  console.log("\n=== ② 実績が落ちていないか (分母つき) ===");
  const expectedVisits = META.firstHalf.length + META.secondHalf.length;
  for (const tag of ["S01", "S02", "S03", "S04"]) {
    const got = byTag.get(tag) ?? [];
    const units = got.reduce((s, r) => s + r.totalUnits, 0);
    const expUnits = WHOLE.units; // 分割してもしなくても総単位は同じ
    const ok = units === expUnits;
    console.log(`  ${ok ? "✓" : "✗"} ${tag}  レセプト ${got.length} 本 / 単位合計 ${units} (期待 ${expUnits} = 訪問 ${expectedVisits} 回 × 567)`);
    if (!ok) fails.push(`${tag}: 単位合計 ${units} ≠ ${expUnits} — 実績が落ちている`);
  }
  // 分割と非分割で総額が 1 円ずれること (= 本当に別レセプトとして丸めている証拠)
  const s01Total = (byTag.get("S01") ?? []).reduce((s, r) => s + r.totalAmount, 0);
  const s02Total = (byTag.get("S02") ?? []).reduce((s, r) => s + r.totalAmount, 0);
  const okDiff = s02Total - s01Total === 1;
  console.log(`  ${okDiff ? "✓" : "✗"} 分割 S01 ¥${s01Total} と 非分割 S02 ¥${s02Total} の差 = ${s02Total - s01Total} 円 (期待 1 = floor が2回効く)`);
  if (!okDiff) fails.push(`S01/S02 の差が ${s02Total - s01Total} 円 (期待 1)`);

  // ── ③ 伝送: 保険者ごとに別明細で出るか ──────────────────────
  console.log("\n=== ③ 伝送 (7131 明細書) の保険者番号 ===");
  const built = buildKokuhoDensou(res.rows as DensouRow[], {
    officeNumber: "9999999904", year: y, month: m, unitPrice: META.unitPrice,
  });
  const lines = built.content.split(/\r?\n/).filter(Boolean);
  const F = (c: string[], n: number) => (c[n + 1] ?? "").replace(/"/g, "").trim();
  const densou: { insurer: string; insured: string }[] = [];
  for (const l of lines) {
    const c = l.split(",");
    if (F(c, 1) === "7131" && F(c, 2) === "01") densou.push({ insurer: F(c, 5), insured: F(c, 6) });
  }
  console.log(`  明細書 ${densou.length} 件 (集計行 ${res.rows.length} 件)`);
  for (const d of densou) console.log(`    保険者 ${d.insurer}  被保番 ${d.insured}`);
  if (densou.length !== res.rows.length) fails.push(`伝送の明細 ${densou.length} 件 ≠ 集計 ${res.rows.length} 行 — 保険者違いの行が落ちている`);
  // S01 の 2 レセプトが別々の保険者番号で出ていること
  const s01Insured = new Set(["9930000101", "9930000102"]);
  const s01Densou = densou.filter((d) => s01Insured.has(d.insured));
  const s01Insurers = new Set(s01Densou.map((d) => d.insurer));
  const okS01 = s01Densou.length === 2 && s01Insurers.size === 2;
  console.log(`  ${okS01 ? "✓" : "✗"} S01 は ${s01Densou.length} 明細 / 保険者 ${[...s01Insurers].join(",")} (期待 2 明細・2 保険者)`);
  if (!okS01) fails.push(`S01 の伝送が ${s01Densou.length} 明細 / 保険者 ${[...s01Insurers].join(",")}`);

  // ── ④ 障害: 市町村変更は分割未対応。warning が出て実績が消えないこと ──
  console.log("\n=== ④ 障害 — 月内の市町村変更 ===");
  const shogaiRes = await aggregateMonthlyShogaiSeikyu(sb, {
    year: y, month: m, unitPrice: META.unitPrice, officeId: META.officeId,
  });
  console.log(`  障害の集計行 ${shogaiRes.rows.length} 件 (分母: この事業所の障害実績 ${META.firstHalf.length + META.secondHalf.length} 件 = S05 の 1 名分)`);
  const s05 = shogaiRes.rows.filter((r) => tagOf.get(r.user_id) === "S05");
  console.log(`  S05 の障害レセプト: ${s05.length} 本  市町村 ${s05.map((r) => r.municipality ?? "—").join(",")}  単位 ${s05.map((r) => r.totalUnits).join(",")}`);
  if (s05.length === 0) {
    fails.push("障害: S05 の集計行が 0 件 — 実績が丸ごと落ちている (分割以前の問題)");
  }
  const muniWarn = shogaiRes.warnings.filter((w) => w.includes("市町村変更"));
  console.log(`  「市町村変更」warning: ${muniWarn.length} 件 (障害 warning 全体の分母 = ${shogaiRes.warnings.length} 件)`);
  if (muniWarn.length === 0 && shogaiRes.warnings.length > 0) {
    console.log("  (参考) 出ている warning:");
    for (const w of shogaiRes.warnings.slice(0, 5)) console.log(`    - ${w}`);
  }
  for (const w of muniWarn) console.log(`    - ${w}`);
  if (muniWarn.length === 0) {
    fails.push("障害: 月内の市町村変更が warning に出ていない — 黙って片方の市町村に寄せている可能性");
  } else {
    console.log(`  ✓ 分割は未対応だが **黙って落とさず warning で知らせている** (居宅の事故とは型が違う)`);
  }
  // ★ 実績そのものが落ちていないこと: 訪問 18 回 × 254 単位 = 4572 が明細に全部あるか
  //   (これとは別に月次加算 116020 = 200 単位が 1 行乗るので総単位は 4772)
  const EXP_VISIT_UNITS = 18 * 254;
  for (const row of s05) {
    const details = (row.details ?? []) as { service_code?: string; count?: number; units?: number }[];
    const visitLine = details.find((d) => d.service_code === "1111011");
    const okVisits = visitLine?.count === 18 && visitLine?.units === EXP_VISIT_UNITS;
    console.log(`  ${okVisits ? "✓" : "✗"} 訪問明細 ${visitLine?.count ?? 0} 回 / ${visitLine?.units ?? 0} 単位 (期待 18 回 / ${EXP_VISIT_UNITS} 単位) — 前半・後半とも残っている`);
    if (!okVisits) fails.push(`障害: 訪問明細が ${visitLine?.count ?? 0} 回 (期待 18) — 市町村変更で実績が落ちている`);
  }
  console.log(`  ⚠ ただし 18 回**すべて**が月末時点の市町村 ${s05[0]?.municipality} 宛の 1 レセプトになる。`);
  console.log(`     前半 10 回は変更前の市町村 (121004) の支給決定分なので、提出先としては誤り。`);
  console.log(`     warning を見た人が手で分けることが前提の運用 (= 自動では正しくならない)。`);

  if (fails.length > 0) { console.log(`\n★ ${fails.length} 件 FAIL`); for (const f of fails) console.log(`  - ${f}`); process.exit(1); }
  console.log(`\nすべて PASS`);
}

main().catch((e) => { console.error(e); process.exit(1); });
