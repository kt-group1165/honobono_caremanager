// ============================================================================
// `clients.benefit_rate` を 認定 (`client_insurance_records`) から導出して是正する。
//
//   node migrations/fix_clients_benefit_rate_from_cert.mjs              # DRY RUN
//   node migrations/fix_clients_benefit_rate_from_cert.mjs --execute
//
// ⚠ **`fix_benefit_rate_from_copay.mjs` とは別の表を直す。**
//     fix_benefit_rate_from_copay.mjs   → `client_insurance_records` (認定)
//     この script                        → `clients` (利用者マスタ)  ← 未対応だった
//
// ── なぜ要るか (2026-09-03 実測) ────────────────────────────────────────
//   **福祉用具の請求 (order-app BillingTab) は `clients.benefit_rate` を使う。**
//   `clients` は 給付率 と 負担割合 を **別々の列**で持ち独立に編集できるので、
//   負担割合証が変わっても給付率が 90 のまま残る。
//
//     髙畠 孝祐  認定 負担割合 "3" / 給付率 "70"  ← clients は 90 のまま
//     村上 正幸  認定 負担割合 "2" / 給付率 "80"  ← clients は 90 のまま
//   → 2026-06 の貸与価格で **保険への過大請求 概算 ¥10,133/月**。
//
//   点検: cd apps/order-app && MONTH=2026-06 npx tsx scripts/benefit-rate-check.mts
//
// ── 直す条件 (材料が 2 つ揃うものだけ) ──────────────────────────────────
//   ① 対象月に有効な認定がある
//   ② 認定の 給付率 と 負担割合 が整合している (benefit + copay×10 = 100)
//      ★ 片方しか無い / 食い違う認定は **触らない**。認定側の是正が先
//        (`fix_benefit_rate_from_copay.mjs` が ほのぼの伝送で裏取りして直す)
//   ③ `clients.benefit_rate` がそれと違う
//
// ── 触らないもの ────────────────────────────────────────────────────────
//   ・公費単独 (被保番 H 始まり)  … 給付率 0 が正しい
//   ・対象月に有効な認定が無い人   … 導出する材料が無い。**一覧に出すだけ**
//     ⚠ 2026-06 で 51 名。最新の認定が 2026-04 (27名) / 2026-05 (24名) に固まっており、
//       **更新の取込が追いついていない**可能性が高い。認定を入れ直してから再実行する。
//
// ⚠ --execute の前にバックアップを取ること:
//     CREATE TABLE _backup_clients_benefit_rate_20260903 AS
//     SELECT id, name, benefit_rate, copay_rate FROM clients;
//   確認後は **DROP する** (CREATE TABLE AS は RLS を継承せず anon に丸見えになる)。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const MONTH = process.env.MONTH ?? "2026-06";
const [Y, M] = MONTH.split("-").map(Number);
const MS = `${MONTH}-01`;
const ME = `${MONTH}-${String(new Date(Y, M, 0).getDate()).padStart(2, "0")}`;

const env = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function all(table, cols, order) {
  const out = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from(table).select(cols).order(order).range(f, f + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

console.log(`=== clients.benefit_rate を認定から是正 (${MONTH}) ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);
console.log(`⚠ 実行前にバックアップを取ること:`);
console.log(`    CREATE TABLE _backup_clients_benefit_rate_20260903 AS`);
console.log(`    SELECT id, name, benefit_rate, copay_rate FROM clients;\n`);

const clients = await all("clients", "id, name, benefit_rate, copay_rate, insured_number", "id");
const certs = await all(
  "client_insurance_records",
  "client_id, copay_rate, benefit_rate, certification_start_date, certification_end_date, effective_date",
  "id",
);

// 対象月に有効な認定のうち effective_date 最新の 1 件
const certOf = new Map();
for (const r of certs) {
  const s = r.certification_start_date ?? r.effective_date;
  const e = r.certification_end_date;
  if (s != null && s > ME) continue;
  if (e != null && e < MS) continue;
  const cur = certOf.get(r.client_id);
  if (!cur || (r.effective_date ?? "") > (cur.effective_date ?? "")) certOf.set(r.client_id, r);
}

// ⚠ 単位が表で違う。`clients` は percent ("10"/"20"/"30") / 認定は 割 ("1"/"2"/"3")
const certCopayPct = (v) => {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n <= 3) return n * 10;
  return n >= 1 ? n : n * 100;
};

const fix = [];
const skipped = { tandoku: 0, noCert: [], certInconsistent: [], certPartial: 0, same: 0, outOfRange: [] };

for (const c of clients) {
  if (/^[Hh]/.test((c.insured_number ?? "").trim())) { skipped.tandoku++; continue; }
  const cert = certOf.get(c.id);
  if (!cert) { skipped.noCert.push(c.name); continue; }

  const cb = cert.benefit_rate == null ? null : parseInt(cert.benefit_rate, 10);
  const cp = certCopayPct(cert.copay_rate);
  // ② 認定の 2 つの列が整合しているものだけ採用する
  if (cb == null || !Number.isFinite(cb) || cp == null) { skipped.certPartial++; continue; }
  if (Math.round(cb + cp) !== 100) {
    skipped.certInconsistent.push(`${c.name}: 認定の 給付率 ${cert.benefit_rate} / 負担割合 ${cert.copay_rate} が不整合`);
    continue;
  }

  // ★ ① 正規化: 認定側は "9"/"8"/"7" の **割表記**が混在している (2,242 行)。
  //   `clients.benefit_rate` は **percent 表記**で、請求 (BillingTab) は
  //   `floor(費用 × benefit_rate / 100)` とそのまま % として読む。
  //   割表記のまま書くと **9% 請求 = 保険が 1/10** になり返戻する。
  const norm = cb > 0 && cb <= 10 ? cb * 10 : cb;

  // ★ ② 出口ガード: 制度上ありえる値以外は **書かない**
  const ALLOWED = [70, 80, 90, 100, 0];
  if (!ALLOWED.includes(norm)) {
    skipped.outOfRange.push(`${c.name}: 認定から導いた給付率 ${norm} が ${ALLOWED.join("/")} 以外 — 書かない`);
    continue;
  }

  const mine = c.benefit_rate == null ? null : parseInt(c.benefit_rate, 10);
  if (mine === norm) { skipped.same++; continue; }
  fix.push({ id: c.id, name: c.name, from: c.benefit_rate, to: String(norm), copay: c.copay_rate, certCopay: cert.copay_rate, certBenefit: cert.benefit_rate });
}

// ★ そのうち「いま福祉用具の請求に出る人」が何名かも出す (影響範囲の見極め用)
const orders = await all("orders", "id, client_id, payment_type", "id");
const oItems = await all("order_items", "order_id, status, payment_type, rental_start_date, rental_end_date", "id");
const payOf = new Map(orders.map((o) => [o.id, o.payment_type]));
const clOf = new Map(orders.map((o) => [o.id, o.client_id]));
const renting = new Set();
for (const i of oItems) {
  if ((i.payment_type ?? payOf.get(i.order_id) ?? "介護") !== "介護") continue;
  if (!i.rental_start_date || i.rental_start_date > ME) continue;
  if (i.status === "terminated" && i.rental_end_date && i.rental_end_date < MS) continue;
  if (i.status !== "rental_started" && i.status !== "terminated") continue;
  const cid = clOf.get(i.order_id);
  if (cid) renting.add(cid);
}
const fixRenting = fix.filter((f) => renting.has(f.id));

console.log(`【分母】clients ${clients.length} 名`);
console.log(`  ★ 直す              ${fix.length} 名`);
console.log(`     └ うち ${MONTH} に福祉用具の請求に出る  ★ ${fixRenting.length} 名 (= いま金額が動く人)`);
for (const f of fixRenting) console.log(`        ${f.name}: 給付率 ${f.from} → ${f.to}`);
console.log(`     ⚠ 残り ${fix.length - fixRenting.length} 名は **いまの請求には出ない**。`);
console.log(`       clients.benefit_rate は他でも参照されうるので直す価値はあるが、`);
console.log(`       **急ぐのは上の ${fixRenting.length} 名**。分けて実行したいなら ONLY_RENTING=1 を付ける。`);
console.log(`  一致していた         ${skipped.same} 名`);
console.log(`  公費単独 (触らない)   ${skipped.tandoku} 名`);
console.log(`  ${MONTH} に有効な認定が無い  ${skipped.noCert.length} 名  ← ★ 材料が無いので触らない`);
console.log(`  認定の給付率か負担割合が片方だけ ${skipped.certPartial} 名`);
console.log(`  ★ 認定自体が不整合    ${skipped.certInconsistent.length} 名  ← 認定側の是正が先`);
console.log(`  ★ 導いた給付率が 70/80/90/100/0 以外 ${skipped.outOfRange.length} 名  ← 出口ガードで書かない`);
for (const s2 of skipped.outOfRange.slice(0, 10)) console.log(`     ⚠ ${s2}`);

for (const s of skipped.certInconsistent.slice(0, 10)) console.log(`     ⚠ ${s}`);
console.log();
// ★ ④ 書き込む値を **全件** 出す (30 件で切らない。目視できないと承認できない)
console.log(`
── 書き込む値 (全 ${fix.length} 件) ──`);
for (const f of fix) {
  console.log(`  ${f.name}: 給付率 ${f.from} → ${f.to}  (clients 負担割合 ${f.copay} / 認定 負担割合 ${f.certCopay} 給付率 ${f.certBenefit})`);
}
const toDist = {};
for (const f of fix) toDist[f.to] = (toDist[f.to] ?? 0) + 1;
console.log(`  書き込む値の分布: ${JSON.stringify(toDist)}`);

if (!EXECUTE) {
  console.log(`\n【DRY RUN】書き込んでいません。--execute で実行`);
  console.log(`⚠ 実行後は必ず点検し直すこと:`);
  console.log(`    cd ../order-app && MONTH=${MONTH} npx tsx scripts/benefit-rate-check.mts`);
  console.log(`    → ①⑥ が 0 名になるはず`);
  process.exit(0);
}

const ONLY = process.env.ONLY_RENTING === "1";
const targets = ONLY ? fixRenting : fix;
console.log(`
  更新対象: ${targets.length} 名 ${ONLY ? "(ONLY_RENTING=1 — 福祉用具の請求に出る人だけ)" : "(全件)"}`);
let n = 0;
for (const f of targets) {
  const { error } = await sb.from("clients").update({ benefit_rate: f.to }).eq("id", f.id);
  if (error) { console.error(`✗ ${f.name}: ${error.message}`); process.exit(1); }
  n++;
}
console.log(`\n  ${n} 名 更新`);

// ★ 件数確認 (DB に聞き直す)
const after = await all("clients", "id, name, benefit_rate", "id");
const byId = new Map(after.map((c) => [c.id, c.benefit_rate]));
const bad = targets.filter((f) => byId.get(f.id) !== f.to);
console.log(`  ★ 件数確認: 想定と違う行 ${bad.length} 件 ${bad.length === 0 ? "✅" : "⚠"}`);

// ★ ③ 実行後に clients.benefit_rate の分布を出す。
//   「直したつもりが 9% 請求を作った」が最悪ケースなので、**割表記が 0 名のまま**かを見る。
const dist = {};
for (const c of after) dist[JSON.stringify(c.benefit_rate)] = (dist[JSON.stringify(c.benefit_rate)] ?? 0) + 1;
console.log(`
  ★ 実行後の clients.benefit_rate 分布: ${JSON.stringify(dist)}`);
const wari = after.filter((c) => {
  const v = c.benefit_rate == null ? null : parseInt(c.benefit_rate, 10);
  return v != null && Number.isFinite(v) && v > 0 && v <= 10;
});
console.log(`  ★ 割表記 (1〜10) の利用者: ${wari.length} 名 ${wari.length === 0 ? "✅ 0 名のまま" : "🔴 **作り込んだ。直ちに戻すこと**"}`);
if (wari.length) for (const w of wari.slice(0, 20)) console.log(`     🔴 ${w.id} = ${JSON.stringify(w.benefit_rate)}`);
