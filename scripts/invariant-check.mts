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
import { aggregateMonthlyShogaiSeikyu } from "@/lib/shogai-seikyu/aggregate";
import { aggregateBathVisitSeikyu } from "@/lib/bath-seikyu/aggregate";

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
type SRow = Awaited<ReturnType<typeof aggregateMonthlyShogaiSeikyu>>["rows"][number];

/** 破れを 1 件ずつ集める。★ 「バグ」とは書かない (不変条件が誤っている場合がある) */
type Violation = { inv: string; office: string; month: string; user: string; detail: string };
/**
 * ★ サンプルデータ由来かどうか。
 *
 * ⚠ この検査は DB 全体を読むので、★ 他セッションが投入中のサンプルを一緒に拾う。
 *   2026-09-04 に実際に踏んだ: 単独では PASS するのに check:all の中では ★ FAIL した。
 *   投入途中 (認定はあるが実績がまだ、等) の行が混ざっていたため。
 *
 * ★ サンプルの破れも隠さず出す。ただし ★ 合否は 実データだけで決める。
 *   隠すと「サンプルで見つかるバグ」を捨てることになり、
 *   合否に混ぜると ★ 他人の作業中に自分の検査が落ちる。
 */
const isSample = (v: Violation) => /\[sample-/.test(v.user) || /^Z[A-Z]\d/.test(v.user);
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

/* ── 障害 (介護給付費) ───────────────────────────────────────────────── */

/** S1 Σ明細 + 加算 = 総単位数 */
function sInv1(r: SRow, ctx: { office: string; month: string }) {
  bump("S1 Σ明細 + 加算 = 総単位数");
  const sum = r.details.reduce((a, d) => a + (d.units ?? 0), 0) + r.addonUnits;
  if (sum !== r.totalUnits)
    violations.push({ inv: "S1", ...ctx, user: r.user_name, detail: `Σ明細+加算 ${sum} ≠ 総単位 ${r.totalUnits}` });
}

/** S2 総費用額 = floor(総単位 × 単価) */
function sInv2(r: SRow, ctx: { office: string; month: string }) {
  bump("S2 総費用額 = floor(総単位 × 単価)");
  const expect = Math.floor((r.totalUnits * Math.round(r.unitPrice * 100)) / 100);
  if (r.totalAmount !== expect)
    violations.push({ inv: "S2", ...ctx, user: r.user_name, detail: `総費用 ${r.totalAmount} ≠ floor(${r.totalUnits} × ${r.unitPrice}) = ${expect}` });
}

/** S3 恒等式 総費用額 = 介護給付費 + 利用者負担 */
function sInv3(r: SRow, ctx: { office: string; month: string }) {
  bump("S3 恒等式 (総費用 = 給付費 + 利用者負担)");
  if (r.benefitAmount + r.userAmount !== r.totalAmount)
    violations.push({ inv: "S3", ...ctx, user: r.user_name, detail: `給付${r.benefitAmount}+利用者${r.userAmount} = ${r.benefitAmount + r.userAmount} ≠ 総費用 ${r.totalAmount}` });
}

/**
 * S4 利用者負担 ≦ 負担上限月額
 * ⚠ 上限管理が「他事業所」のときは他所で調整されるので対象外にする。
 *   ここを見ないと「上限超え」に見える行が正常でも鳴る。
 */
function sInv4(r: SRow, ctx: { office: string; month: string }) {
  if (r.self_payment_limit === null) return;
  if (r.jogenKanriKubun === "他事業所") return;
  bump("S4 利用者負担 ≦ 負担上限月額 (上限管理が他事業所の行は除く)");
  if (r.userAmount > r.self_payment_limit)
    violations.push({ inv: "S4", ...ctx, user: r.user_name, detail: `利用者負担 ${r.userAmount} > 上限 ${r.self_payment_limit} (上限管理=${r.jogenKanriKubun})` });
}

/** S5 明細・加算にサービスコードが付いている (無いと伝送に出せない) */
function sInv5(r: SRow, ctx: { office: string; month: string }) {
  bump("S5 障害 明細・加算にサービスコードが付いている");
  const miss = r.details.filter((d) => !d.service_code);
  if (miss.length)
    violations.push({ inv: "S5", ...ctx, user: r.user_name, detail: `明細のコード未解決 ${miss.length} 行: ${miss.slice(0, 3).map((d) => d.service_type).join(" / ")}` });
  const badAddon = r.addons.filter((a) => !/^\d{6}$/.test(a.service_code ?? ""));
  if (badAddon.length)
    violations.push({ inv: "S5", ...ctx, user: r.user_name, detail: `加算コードが6桁でない ${badAddon.length} 行: ${badAddon.slice(0, 3).map((a) => a.service_code).join(" / ")}` });
}

/* ── 居宅介護支援 (居宅介護支援費) ─────────────────────────────────────── */

/** レセプト 1 行 (kaigo_care_support_claims) */
type KRow = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0);

/** 加算の単位数の列 (合計に足すもの)。★ 足し忘れると総額が合わない */
const K_ADDON_UNITS = [
  "initial_addition_units", "hospital_coordination_units", "discharge_addition_units",
  "medical_coordination_units", "tokutei_kassan_units", "medical_coop_kassan_units",
  "terminal_care_units", "emergency_conference_units", "shoguu_kaizen_units",
];
/** フラグ ↔ 単位数 の対。★ 同じ事実を 2 列で持っているので必ずずれる型 */
const K_FLAG_PAIRS: [string, string][] = [
  ["initial_addition", "initial_addition_units"],
  ["hospital_coordination", "hospital_coordination_units"],
  ["discharge_addition", "discharge_addition_units"],
  ["medical_coordination", "medical_coordination_units"],
  ["medical_coop_kassan", "medical_coop_kassan_units"],
  ["terminal_care", "terminal_care_units"],
  ["emergency_conference", "emergency_conference_units"],
  ["unei_kijun_gensan", "unei_kijun_gensan_units"],
];

/** K1 総額 = floor((基本単位 + Σ加算単位 − 運営基準減算) × 単価) */
function kInv1(r: KRow, ctx: { office: string; month: string }) {
  bump("K1 総額 = floor(Σ単位 × 単価)");
  const sum = num(r.units) + K_ADDON_UNITS.reduce((a, k) => a + num(r[k]), 0) - num(r.unei_kijun_gensan_units);
  const expect = Math.floor(sum * num(r.unit_price));
  if (expect !== num(r.total_amount))
    violations.push({ inv: "K1", ...ctx, user: String(r.insured_number ?? r.id), detail: `Σ単位 ${sum} × 単価 ${r.unit_price} = ${expect} ≠ 総額 ${r.total_amount}` });
}

/** K2 保険請求額 = 総額 (居宅介護支援費は 10割給付・利用者負担なし) */
function kInv2(r: KRow, ctx: { office: string; month: string }) {
  bump("K2 保険請求額 = 総額 (10割給付)");
  if (num(r.insurance_amount) !== num(r.total_amount))
    violations.push({ inv: "K2", ...ctx, user: String(r.insured_number ?? r.id), detail: `保険 ${r.insurance_amount} ≠ 総額 ${r.total_amount}` });
}

/** K3 フラグが立つ ⇔ 単位数 > 0 */
function kInv3(r: KRow, ctx: { office: string; month: string }) {
  bump("K3 加算フラグ ⇔ 単位数 > 0");
  for (const [f, u] of K_FLAG_PAIRS) {
    const on = r[f] === true;
    const pos = num(r[u]) > 0;
    if (on !== pos)
      violations.push({ inv: "K3", ...ctx, user: String(r.insured_number ?? r.id), detail: `${f}=${on} なのに ${u}=${r[u]}` });
  }
  const tType = String(r.tokutei_kassan_type ?? "").trim();
  if (!!tType !== (num(r.tokutei_kassan_units) > 0))
    violations.push({ inv: "K3", ...ctx, user: String(r.insured_number ?? r.id), detail: `特定事業所加算 種別="${tType}" なのに 単位=${r.tokutei_kassan_units}` });
}

/**
 * K4 基本コードと処遇改善コードの系統が揃っている (43=居宅 / 46=予防)
 * ⚠ ★ 基本コードが null の行が実在する (2026-09-03 実測 1 件)。
 *   月途中で亡くなると給付管理をしないので居宅介護支援費が立たず、
 *   ターミナルケアマネジメント加算だけを請求する。★ これは正常なので除外する。
 */
function kInv4(r: KRow, ctx: { office: string; month: string }) {
  const base = String(r.care_support_code ?? "");
  const sho = String(r.shoguu_kaizen_code ?? "");
  if (!base) return; // ★ 基本コードなしは正常 (上記)
  bump("K4 基本コードと処遇改善コードの系統が一致 (43/46)");
  if (!/^(43|46)/.test(base))
    violations.push({ inv: "K4", ...ctx, user: String(r.insured_number ?? r.id), detail: `基本コード ${base} が 43/46 系でない` });
  if (sho && base.slice(0, 2) !== sho.slice(0, 2))
    violations.push({ inv: "K4", ...ctx, user: String(r.insured_number ?? r.id), detail: `基本 ${base} と処遇改善 ${sho} で系統が違う (43=居宅 / 46=予防 の混在は返戻要因)` });
}

/** K5 単価が入っている (0 だと総額が必ず 0 になる) */
function kInv5(r: KRow, ctx: { office: string; month: string }) {
  bump("K5 単価 > 0");
  if (!(num(r.unit_price) > 0))
    violations.push({ inv: "K5", ...ctx, user: String(r.insured_number ?? r.id), detail: `単価 ${r.unit_price}` });
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
  let lastShogaiRow: SRow | null = null;
  let sougouRowCount = 0;
  let kyotakuRowCount = 0;
  let lastKRow: KRow | null = null;
  let noShoguu = 0;
  let noBaseCode = 0;
  let bathRowCount = 0;
  let shogaiRowCount = 0;
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
      // 総合事業 — 行の型は介護と同じなので同じ条件を当てる
      for (const r of res.sougouRows ?? []) {
        rowCount++;
        sougouRowCount++;
        inv1(r, ctx); inv2(r, ctx); inv3(r, ctx); inv4(r, ctx); inv5(r, ctx); inv6(r, ctx); inv7(r, ctx);
      }
      // 障害
      let sres;
      try {
        sres = await aggregateMonthlyShogaiSeikyu(sb, {
          // ⚠ 障害の集計は tenantId を取らない (officeId でスコープする)。渡すと tsc が落ちる
          year: y, month: mo, officeId: o.id as string,
        });
      } catch (e) {
        console.log(`  ⚠ ${o.name} ${m}: 障害の集計に失敗 — ${e instanceof Error ? e.message : String(e)}`);
        sres = null;
      }
      for (const r of sres?.rows ?? []) {
        shogaiRowCount++;
        if (r.details.length && r.addons.length) lastShogaiRow = r;
        sInv1(r, ctx); sInv2(r, ctx); sInv3(r, ctx); sInv4(r, ctx); sInv5(r, ctx);
      }
    }
  }

  // ── 訪問入浴 ──
  //   ★ 戻り値の型が 訪問介護 と同じ (MonthlySeikyuResult) なので I1-I7 をそのまま当てる。
  //   ⚠ 2026-09-03 に「要支援の利用者に介護給付のコードが付く」バグが見つかった制度。
  //     実データに要支援が居なかったのでサンプルでしか出なかった。
  {
    const { data: bathOffices, error: e } = await sb
      .from("offices").select("id, name, tenant_id, unit_price, applied_formula_codes").order("name");
    if (e) throw new Error(`offices 取得に失敗: ${e.message}`);
    const bt = (bathOffices ?? []).filter((o) => /訪問入浴/.test(String(o.name)));
    for (const o of bt) {
      for (const m of MONTHS) {
        const [y, mo] = m.split("-").map(Number);
        let res;
        try {
          res = await aggregateBathVisitSeikyu(sb, {
            officeId: o.id as string, tenantId: o.tenant_id as string, year: y, month: mo,
            unitPrice: (o.unit_price as number) ?? undefined,
            appliedFormulaCodes: (o.applied_formula_codes as string[]) ?? [],
          });
        } catch (err) {
          console.log(`  ⚠ ${o.name} ${m}: 訪問入浴の集計に失敗 — ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        const ctx = { office: String(o.name), month: m };
        for (const r of res.rows) {
          bathRowCount++;
          inv1(r, ctx); inv2(r, ctx); inv3(r, ctx); inv4(r, ctx); inv5(r, ctx); inv6(r, ctx); inv7(r, ctx);
        }
      }
    }
  }

  // ── 居宅介護支援 (レセプトは集計ではなく table に入っている) ──
  {
    const rows: KRow[] = [];
    for (let off = 0; ; off += 1000) {
      const { data, error: e } = await sb
        .from("kaigo_care_support_claims").select("*").order("id", { ascending: true }).range(off, off + 999);
      if (e) throw new Error(`居宅レセプトの取得に失敗: ${e.message}`);
      rows.push(...((data ?? []) as KRow[]));
      if ((data ?? []).length < 1000) break;
    }
    for (const r of rows) {
      kyotakuRowCount++;
      if (String(r.care_support_code ?? "") && r.initial_addition === true) lastKRow = r;
      if (!r.shoguu_kaizen_code) noShoguu++;
      if (!r.care_support_code) noBaseCode++;
      const ctx = { office: "居宅介護支援 (全事業所)", month: String(r.billing_month ?? "?") };
      kInv1(r, ctx); kInv2(r, ctx); kInv3(r, ctx); kInv4(r, ctx); kInv5(r, ctx);
    }
  }

  // ★ 分母を必ず出す。0 行で「全部合格」を出さないため (規律 1-2)
  console.log(`検査した行: 介護+総合事業 ${rowCount} 行 (うち総合事業 ${sougouRowCount}) / 障害 ${shogaiRowCount} 行 / 居宅介護支援 ${kyotakuRowCount} 行 / ★ 訪問入浴 ${bathRowCount} 行 / 実績のあった (事業所×月) ${officesWithRows} 組
`);
  if (rowCount === 0 || shogaiRowCount === 0 || kyotakuRowCount === 0) {
    console.log(`★ FAIL 検査対象が 0 行の制度があります (介護+総合 ${rowCount} / 障害 ${shogaiRowCount} / 居宅 ${kyotakuRowCount})。合格ではありません。`);
    process.exit(1);
  }
  for (const [k, v] of Object.entries(checked)) console.log(`  ${k.padEnd(44)} ${v} 回`);
  console.log("");
  console.log("── 観測 (合否ではない。数だけ出す)");
  console.log(`   居宅介護支援で 処遇改善コードが無い行     ${noShoguu} 件  ★ 既知: ケアプランＨａｎａ船橋 の未算定`);
  console.log(`   居宅介護支援で 基本コードが無い行         ${noBaseCode} 件  ★ 正常: ターミナルのみの請求`);
  if (bathRowCount === 0) {
    // ★ 0 行の理由を必ず添える。黙って 0 を出すと「検査した」と誤読される
    console.log("   ★ 訪問入浴は 0 行 — 事業所は 5 件あるが kaigo_bath_schedule / _visit_records とも");
    console.log("      ★ 実データが 1 行も無い (稼働前)。実データでは検証できず ★ サンプルでしか通せない。");
    console.log("      2026-09-03 の「要支援に介護給付コードが付く」バグも ★ サンプルでしか出なかった。");
  }
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
    // 障害側も同じように「わざと壊す」
    const sProbe = lastShogaiRow;
    if (!sProbe) throw new Error("障害の負のコントロール用の行がありません");
    const sCases: [string, SRow][] = [
      ["S1", { ...sProbe, totalUnits: sProbe.totalUnits + 1 }],
      ["S2", { ...sProbe, totalAmount: sProbe.totalAmount + 1 }],
      ["S3", { ...sProbe, userAmount: sProbe.userAmount + 1 }],
      // ★ 上限管理が「他事業所」だと S4 は素通りするので、条件を満たす形に作り替える
      ["S4", { ...sProbe, jogenKanriKubun: "なし", self_payment_limit: 0, userAmount: 1 }],
      ["S5", { ...sProbe, details: [{ ...sProbe.details[0], service_code: null }] }],
    ];
    for (const [tag, bad] of sCases) {
      const n = violations.length;
      sInv1(bad, ctx); sInv2(bad, ctx); sInv3(bad, ctx); sInv4(bad, ctx); sInv5(bad, ctx);
      if (violations.some((v, i) => i >= n && v.inv === tag)) fired.add(tag);
    }
    const kProbe = lastKRow;
    if (!kProbe) throw new Error("居宅の負のコントロール用の行がありません");
    const kCases: [string, KRow][] = [
      ["K1", { ...kProbe, total_amount: num(kProbe.total_amount) + 1 }],
      ["K2", { ...kProbe, insurance_amount: num(kProbe.insurance_amount) + 1 }],
      ["K3", { ...kProbe, initial_addition_units: 0 }],
      ["K4", { ...kProbe, shoguu_kaizen_code: "466191" }],
      ["K5", { ...kProbe, unit_price: 0 }],
    ];
    for (const [tag, bad] of kCases) {
      const n = violations.length;
      kInv1(bad, ctx); kInv2(bad, ctx); kInv3(bad, ctx); kInv4(bad, ctx); kInv5(bad, ctx);
      if (violations.some((v, i) => i >= n && v.inv === tag)) fired.add(tag);
    }
    const ALL = ["I1", "I2", "I3", "I4", "I5", "I6", "I7", "S1", "S2", "S3", "S4", "S5", "K1", "K2", "K3", "K4", "K5"];
    const missing = ALL.filter((t) => !fired.has(t));
    if (missing.length) {
      console.log(`★ FAIL 負のコントロールで鳴らなかった条件: ${missing.join(" / ")}`);
      console.log("   → その条件は ★ 効いていません。PASS を信用しないでください。");
      process.exit(1);
    }
    console.log(`負のコントロール: わざと壊すと ${ALL.length} 本すべてが鳴る (= 検査は効いている)`);
    console.log("PASS — 破れなし");
    return;
  }
  const sampleV = violations.filter(isSample);
  const realV = violations.filter((v) => !isSample(v));
  if (sampleV.length) {
    console.log(`⚠ ★ サンプル由来の破れ ${sampleV.length} 件 (★ 合否には入れない — 他セッションが投入中の可能性)`);
    for (const v of sampleV.slice(0, 6)) console.log(`   ${v.inv} ${v.office} ${v.month} ${v.user}: ${v.detail}`);
    if (sampleV.length > 6) console.log(`   … 他 ${sampleV.length - 6} 件`);
    console.log("");
  }
  if (realV.length === 0) {
    console.log(`PASS — 実データの破れなし (★ サンプル由来 ${sampleV.length} 件は上記のとおり別掲)`);
    return;
  }
  const byInv = new Map<string, Violation[]>();
  for (const v of realV) { if (!byInv.has(v.inv)) byInv.set(v.inv, []); byInv.get(v.inv)!.push(v); }
  console.log(`★ 実データの破れ ${realV.length} 件
`);
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
