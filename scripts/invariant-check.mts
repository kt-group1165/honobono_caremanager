/**
 * 不変条件を **全事業所・全月** に当てる (READ ONLY・DB に書かない)
 *
 *   npx tsx scripts/invariant-check.mts            2026-06 / 2026-07
 *   MONTHS=2026-06 npx tsx scripts/invariant-check.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   smoke は **数事業所ぶんの期待値**を守るもの。値が変わったら落ちるが、
 *   ★ 「そもそも成り立つはずの関係」が全事業所で成り立つかは見ていない。
 *   docs/VERIFY_INVARIANTS.md の確定条件を **全件に当てる**。
 *
 *   今日いちばん当たりが多かったのは ★ 分母を広げる作業なので、同じことをする。
 *
 * ⚠ 破れたら「バグ」と決めない。★ 不変条件のほうが間違っている可能性が先。
 *   実例: 「限度額管理対象単位数 ≦ 合計単位数」は自明に見えて ★ 反例がある
 *   (いすみ 32,542 > 31,942)。docs/VERIFY_INVARIANTS.md の「候補」を見ること。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { aggregateMonthlyVisitSeikyu } from "@/lib/visit-seikyu/aggregate";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env: Record<string, string> = {};
for (const l of readFileSync(join(__dirname, "..", ".env.local"), "utf8").split(/\r?\n/)) {
  const i = l.indexOf("=");
  if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) {
  // 1-2: 鍵が無いまま anon で回すと RLS で 0 行になり「全部合格」に見える
  throw new Error("SUPABASE_SERVICE_ROLE_KEY がありません。中止します。");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const MONTHS = (process.env.MONTHS ?? "2026-06,2026-07").split(",").map((s) => s.trim());

type Row = Awaited<ReturnType<typeof aggregateMonthlyVisitSeikyu>>["rows"][number];

/** 破れを 1 件ずつ集める。★ 「バグ」とは書かない (不変条件が誤っている場合がある) */
type Violation = { inv: string; office: string; month: string; user: string; detail: string };
const violations: Violation[] = [];
const checked: Record<string, number> = {};
const bump = (k: string) => { checked[k] = (checked[k] ?? 0) + 1; };

/** 確定#1 Σ明細行の単位 == 明細合計単位数 */
function inv1(r: Row, ctx: { office: string; month: string }) {
  bump("I1 Σ明細 = grossBaseUnits");
  const sum = r.details.reduce((a, d) => a + (d.units ?? 0), 0);
  if (sum !== r.grossBaseUnits)
    violations.push({ inv: "I1", ...ctx, user: r.user_name, detail: `Σ明細 ${sum} ≠ grossBaseUnits ${r.grossBaseUnits}` });
}

/** 確定#2 金額 = floor(単位 × 単価) — 端数は必ず利用者側に落ちる */
function inv2(r: Row, ctx: { office: string; month: string }) {
  bump("I2 総額 = floor(総単位 × 単価)");
  const expect = Math.floor((r.totalUnits * Math.round(r.unitPrice * 100)) / 100);
  if (r.totalAmount !== expect)
    violations.push({ inv: "I2", ...ctx, user: r.user_name, detail: `総額 ${r.totalAmount} ≠ floor(${r.totalUnits} × ${r.unitPrice}) = ${expect}` });
}

/**
 * 恒等式 総額 = 保険 + 公費1 + 公費2 + 利用者負担
 *
 * ⚠ ★ 超過自費 (selfPayAmount) は totalAmount に **含まれない**。
 *   最初 右辺に足して 23 件の「破れ」を出したが、★ 私の式の誤りだった。
 *   smoke の見出しは「総額=保険+公費+利用者+超過」だが、実装は両辺に超過を足していて
 *   ★ 相殺されるので、実質この式。見出しに引きずられないこと。
 */
function inv3(r: Row, ctx: { office: string; month: string }) {
  bump("I3 恒等式 (総額 = 保険+公費1+公費2+利用者)");
  const s = r.insuranceAmount + (r.kohiAmount ?? 0) + (r.kohi2Amount ?? 0) + r.userAmount;
  if (s !== r.totalAmount)
    violations.push({ inv: "I3", ...ctx, user: r.user_name, detail: `保険${r.insuranceAmount}+公費${r.kohiAmount ?? 0}+公費2${r.kohi2Amount ?? 0}+利用者${r.userAmount} = ${s} ≠ 総額 ${r.totalAmount}` });
}

/** 本体 + %加算 = 総単位 */
function inv4(r: Row, ctx: { office: string; month: string }) {
  bump("I4 baseUnits + addonUnits = totalUnits");
  if (r.baseUnits + r.addonUnits !== r.totalUnits)
    violations.push({ inv: "I4", ...ctx, user: r.user_name, detail: `本体${r.baseUnits} + 加算${r.addonUnits} = ${r.baseUnits + r.addonUnits} ≠ 総単位 ${r.totalUnits}` });
}

/** 超過があるなら全額自費が立つ (overAmount と selfPayAmount は同値のはず) */
function inv5(r: Row, ctx: { office: string; month: string }) {
  bump("I5 超過単位 > 0 → 自費額 > 0 / overAmount = selfPayAmount");
  if (r.overUnits > 0 && r.selfPayAmount <= 0)
    violations.push({ inv: "I5", ...ctx, user: r.user_name, detail: `超過 ${r.overUnits} 単位あるのに自費 ${r.selfPayAmount} 円` });
  if (r.overAmount !== r.selfPayAmount)
    violations.push({ inv: "I5", ...ctx, user: r.user_name, detail: `overAmount ${r.overAmount} ≠ selfPayAmount ${r.selfPayAmount}` });
}

/** 保険請求額 = floor(保険給付対象費用 × 給付率)。給付率は copay_rate から整数演算で出す */
function inv6(r: Row, ctx: { office: string; month: string }) {
  if (r.kohiAmount !== null && r.kohiAmount > 0) return; // 公費併用は配分が別。ここでは見ない
  bump("I6 保険請求額 = floor(給付対象 × 給付率)");
  const benefit = (10 - Math.round(r.copay_rate * 10)) * 10; // 0.1 → 90
  // ⚠ totalAmount は ★ 超過自費を含まない (= 既に給付対象だけ)。引くと二重に減る
  const covered = r.totalAmount;
  const expect = Math.floor((covered * benefit) / 100);
  if (r.insuranceAmount !== expect)
    violations.push({ inv: "I6", ...ctx, user: r.user_name, detail: `保険 ${r.insuranceAmount} ≠ floor(${r.totalAmount} × ${benefit}%) = ${expect} (負担割合 ${r.copay_rate})` });
}

/** 明細のサービスコードが引けているか (引けないと伝送に出せない) */
function inv7(r: Row, ctx: { office: string; month: string }) {
  bump("I7 明細にサービスコードが付いている");
  const miss = r.details.filter((d) => !d.service_code);
  if (miss.length)
    violations.push({ inv: "I7", ...ctx, user: r.user_name, detail: `コード未解決 ${miss.length} 行: ${miss.slice(0, 3).map((d) => d.service_type).join(" / ")}` });
}

async function main() {
  const { data: offices, error } = await sb
    .from("offices")
    .select("id, name, tenant_id, unit_price, applied_formula_codes, service_type")
    .order("name");
  if (error) throw new Error(`offices 取得に失敗: ${error.message}`);
  const targets = (offices ?? []).filter((o) => /訪問介護|ヘルパー/.test(String(o.name)) || String(o.service_type ?? "").includes("訪問介護"));
  if (targets.length === 0) throw new Error("対象事業所が 0 件です (絞り込みを疑ってください)");

  console.log(`不変条件チェック — 事業所 ${targets.length} / 月 ${MONTHS.join(" ")}  (READ ONLY)\n`);
  let rowCount = 0;
  let officesWithRows = 0;
  let lastRow: Row | null = null;
  for (const o of targets) {
    for (const m of MONTHS) {
      const [y, mo] = m.split("-").map(Number);
      let res;
      try {
        res = await aggregateMonthlyVisitSeikyu(sb, {
          officeId: o.id as string,
          tenantId: o.tenant_id as string,
          year: y,
          month: mo,
          unitPrice: (o.unit_price as number) ?? undefined,
          appliedFormulaCodes: (o.applied_formula_codes as string[]) ?? [],
        });
      } catch (e) {
        console.log(`  ⚠ ${o.name} ${m}: 集計に失敗 — ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      const ctx = { office: String(o.name), month: m };
      if (res.rows.length) officesWithRows++;
      for (const r of res.rows) {
        rowCount++;
        if (r.details.length && r.overUnits > 0) lastRow = r;
        inv1(r, ctx); inv2(r, ctx); inv3(r, ctx); inv4(r, ctx); inv5(r, ctx); inv6(r, ctx); inv7(r, ctx);
      }
    }
  }

  // ★ 分母を必ず出す。0 行で「全部合格」を出さないため (規律 1-2)
  console.log(`検査した行: ${rowCount} 行 / 実績のあった (事業所×月) ${officesWithRows} 組\n`);
  if (rowCount === 0) {
    console.log("★ FAIL 検査対象が 0 行です。合格ではありません。");
    process.exit(1);
  }
  for (const [k, v] of Object.entries(checked)) console.log(`  ${k.padEnd(44)} ${v} 回`);
  console.log("");

  if (violations.length === 0) {
    // ★ 負のコントロール (規律 3-9)。全部通る検査は「効いていない検査」と区別が付かない。
    //   わざと壊した行を流し、★ 7 本すべてが 1 件以上鳴ることを確かめる。
    const probe = lastRow;
    if (!probe) throw new Error("負のコントロール用の行がありません");
    const fired = new Set<string>();
    const before = violations.length;
    const ctx = { office: "★負のコントロール", month: "----" };
    const cases: [string, Row][] = [
      ["I1", { ...probe, grossBaseUnits: probe.grossBaseUnits + 1 }],
      ["I2", { ...probe, totalAmount: probe.totalAmount + 1 }],
      ["I3", { ...probe, userAmount: probe.userAmount + 1 }],
      ["I4", { ...probe, addonUnits: probe.addonUnits + 1 }],
      ["I5", { ...probe, overAmount: probe.overAmount + 1 }],
      ["I6", { ...probe, insuranceAmount: probe.insuranceAmount + 1, kohiAmount: null }],
      ["I7", { ...probe, details: [{ ...probe.details[0], service_code: null }] }],
    ];
    for (const [tag, bad] of cases) {
      const n = violations.length;
      inv1(bad, ctx); inv2(bad, ctx); inv3(bad, ctx); inv4(bad, ctx); inv5(bad, ctx); inv6(bad, ctx); inv7(bad, ctx);
      if (violations.some((v, i) => i >= n && v.inv === tag)) fired.add(tag);
    }
    violations.length = before; // 実データの結果に影響させない
    const missing = ["I1", "I2", "I3", "I4", "I5", "I6", "I7"].filter((t) => !fired.has(t));
    if (missing.length) {
      console.log(`★ FAIL 負のコントロールで鳴らなかった条件: ${missing.join(" / ")}`);
      console.log("   → その条件は ★ 効いていません。PASS を信用しないでください。");
      process.exit(1);
    }
    console.log("負のコントロール: わざと壊すと 7 本すべてが鳴る (= 検査は効いている)");
    console.log("PASS — 破れなし");
    return;
  }
  const byInv = new Map<string, Violation[]>();
  for (const v of violations) { if (!byInv.has(v.inv)) byInv.set(v.inv, []); byInv.get(v.inv)!.push(v); }
  console.log(`★ 破れ ${violations.length} 件\n`);
  for (const [inv, list] of [...byInv].sort()) {
    console.log(`── ${inv} — ${list.length} 件`);
    for (const v of list.slice(0, 8)) console.log(`   ${v.office} ${v.month} ${v.user}: ${v.detail}`);
    if (list.length > 8) console.log(`   … 他 ${list.length - 8} 件`);
    console.log("");
  }
  console.log("⚠ 破れ = バグ とは限りません。★ 不変条件のほうが誤っている可能性を先に潰してください。");
  console.log("  docs/VERIFY_INVARIANTS.md の「候補」に落とすべきものが混ざっている場合があります。");
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
