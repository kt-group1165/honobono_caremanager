/**
 * 障害サンプルの検証 — ★ 実データに 1 件も無い 3 経路を通す
 *
 *   npx tsx scripts/shogai-sample-verify.mts
 *
 * 前提: migrations/seed_sample_shogai_h.mjs --execute で投入済みであること。
 *
 * ⚠ 期待値は ★ 実装の出力ではなく、制度の規則から手で置く。
 *     生保              → 利用者負担 0 円 / 給付費 = 総費用
 *     上限管理 = 他事業所 + 管理結果 区分2 → ★ 当方の利用者負担は 0 円
 *     上限 4,600 で 1割が超える → 負担は 4,600 で頭打ち
 *
 * ⚠ ★ 分母を必ず出す。0 行で「合格」を出さない (規律 1-2)。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { aggregateMonthlyShogaiSeikyu } from "@/lib/shogai-seikyu/aggregate";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env: Record<string, string> = {};
for (const l of readFileSync(join(__dirname, "..", ".env.local"), "utf8").split(/\r?\n/)) {
  const i = l.indexOf("=");
  if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY がありません。中止します。");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const OFFICE_ID = "e7c3c270-3310-4e83-9d6a-79761070a2c3";
const [Y, M] = [2026, 12];

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

const res = await aggregateMonthlyShogaiSeikyu(sb, { year: Y, month: M, officeId: OFFICE_ID });
const rows = res.rows.filter((r) => /\[sample-h\]/.test(r.user_name));

console.log(`障害サンプル検証 — 2026-12 / 事業所 ${OFFICE_ID}`);
console.log(`  集計の全行 ${res.rows.length} / うち ★ サンプル ${rows.length} 行\n`);
if (rows.length === 0) {
  console.log("★ FAIL サンプルが 0 行です。合格ではありません。");
  console.log("   seed を --execute したか / 月・事業所が合っているかを確認してください。");
  process.exit(1);
}

const by = (seq: number) => rows.find((r) => r.user_name.includes(`サンプル${seq}`));

// ── ① 生保 ────────────────────────────────────────────────────────────
{
  const r = by(901);
  if (!r) fails.push("901 (生保) の行がありません");
  else {
    console.log(`① 生保        総費用 ${r.totalAmount} / 給付 ${r.benefitAmount} / 利用者 ${r.userAmount}`);
    eq("★ 生保は 利用者負担 0 円", r.userAmount, 0);
    eq("★ 生保は 給付費 = 総費用", r.benefitAmount, r.totalAmount);
    eq("生保フラグが読めている", r.seiho, true);
    eq("恒等式 総費用 = 給付 + 利用者", r.benefitAmount + r.userAmount, r.totalAmount);
  }
}

// ── ② 上限管理 = 他事業所 + 管理結果 区分2 ─────────────────────────────
{
  const r = by(902);
  if (!r) fails.push("902 (区分2) の行がありません");
  else {
    console.log(`② 区分2       総費用 ${r.totalAmount} / 給付 ${r.benefitAmount} / 利用者 ${r.userAmount} / 管理結果 ${r.kanriResult}`);
    eq("上限管理の区分が読めている", r.jogenKanriKubun, "他事業所");
    eq("★ 管理結果 区分2 が読めている", r.kanriResult, 2);
    // ⚠ ★ 私の期待値が誤っていた (2026-09-04)。「区分2 = 他事業所が管理して当方は0円」
    //   と思い込んで書いたが、★ それは 区分1 の意味。
    //     区分1 管理事業所で上限額に充当済 → ★ 他事業所の利用者負担は 0 円
    //     区分2 ★ 利用者負担の合計が 上限月額 以下 → 調整事務を行わない = そのまま請求
    //     区分3 合計が 上限を超える → 管理結果票のとおり調整
    //   実装のコメント (aggregate.ts:1124) も「区分 1 / 3 → 調整後額に置換」で、
    //   ★ 実装が正しく、私の期待値が間違っていた。
    //   このサンプルは 上限 37,200 に対し 1割が 4,657 なので ★ 区分2 が成立する条件。
    eq("★ 区分2 は 調整しない = 1割がそのまま", r.userAmount, Math.floor(r.totalAmount * 0.1));
    eq("区分2 の給付費 = 総費用 − 利用者負担", r.benefitAmount, r.totalAmount - r.userAmount);
    eq("恒等式 総費用 = 給付 + 利用者", r.benefitAmount + r.userAmount, r.totalAmount);
    eq("★ 事業所番号が入っている (空だと返戻)", r.jogenKanriOfficeNumber, "1210600019");
  }
}

// ── ③ 上限 4,600 で 1割が超える ────────────────────────────────────────
{
  const r = by(903);
  if (!r) fails.push("903 (上限 4,600) の行がありません");
  else {
    const tenPct = Math.floor(r.totalAmount * 0.1);
    console.log(`③ 上限4,600  総費用 ${r.totalAmount} / 1割 ${tenPct} / 利用者 ${r.userAmount}`);
    eq("負担上限が読めている", r.self_payment_limit, 4600);
    if (tenPct <= 4600) {
      fails.push(`★ 前提が崩れています: 1割 ${tenPct} が上限 4,600 を超えていません。実績日数を増やしてください`);
    } else {
      eq("★ 1割が上限を超えるので 負担は上限で頭打ち", r.userAmount, 4600);
      eq("恒等式 総費用 = 給付 + 利用者", r.benefitAmount + r.userAmount, r.totalAmount);
    }
  }
}

// ── 共通の不変条件 ────────────────────────────────────────────────────
for (const r of rows) {
  const sum = r.details.reduce((a, d) => a + d.units, 0) + r.addonUnits;
  eq(`[${r.user_name}] Σ明細+加算 = 総単位`, sum, r.totalUnits);
  eq(`[${r.user_name}] 総費用 = floor(総単位 × 単価)`, r.totalAmount,
     Math.floor((r.totalUnits * Math.round(r.unitPrice * 100)) / 100));
  eq(`[${r.user_name}] 明細にコードが付いている`, r.details.filter((d) => !d.service_code).length, 0);
}

// ── 負のコントロール (3-9) ─────────────────────────────────────────────
// ★ 全部通る検査は「効いていない検査」と区別が付かない。わざと壊して鳴ることを確かめる。
{
  const probe = rows[0];
  const before = fails.length;
  const fired: string[] = [];
  const check = (label: string, cond: boolean) => { if (cond) fired.push(label); };
  // 生保なのに負担が乗っている
  check("生保に負担", ({ ...probe, seiho: true, userAmount: 1 }).userAmount !== 0);
  // 恒等式が壊れている
  const bad = { ...probe, userAmount: probe.userAmount + 1 };
  check("恒等式", bad.benefitAmount + bad.userAmount !== bad.totalAmount);
  // Σ明細 + 加算 が総単位と合わない
  const bad2 = { ...probe, totalUnits: probe.totalUnits + 1 };
  check("Σ明細", probe.details.reduce((a, d) => a + d.units, 0) + probe.addonUnits !== bad2.totalUnits);
  // 総費用が単価計算と合わない
  const bad3 = { ...probe, totalAmount: probe.totalAmount + 1 };
  check("総費用", bad3.totalAmount !== Math.floor((bad3.totalUnits * Math.round(bad3.unitPrice * 100)) / 100));
  // 明細のコードが欠けている
  check("コード欠け", [{ ...probe.details[0], service_code: null }].filter((d) => !d.service_code).length !== 0);
  if (fired.length === 5) pass++;
  else fails.push(`★ 負のコントロールが鳴らない (${fired.length}/5: ${fired.join(",")}) — 検査が効いていません`);
  if (fails.length > before) console.log("⚠ 負のコントロールで問題");
  else console.log("負のコントロール: わざと壊すと 5 本すべてが鳴る");
}

console.log("");
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (サンプル ${rows.length} 行)`);
} else {
  console.log(`★ FAIL ${fails.length} 件 / 一致 ${pass} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exit(1);
}
