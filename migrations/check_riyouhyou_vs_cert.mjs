// ============================================================================
// 利用票 (第6表 PDF) と 認定 (介護保険1.CSV 由来) を突き合わせる。**READ ONLY**
//
//   node migrations/check_riyouhyou_vs_cert.mjs
//   MONTH=2026-06 node migrations/check_riyouhyou_vs_cert.mjs
//
// ── なぜ突き合わせるのか ────────────────────────────────────────────────
//   どちらも ほのぼの由来だが **経路がまったく別**:
//     利用票  ケアマネ → 印刷 → PDF → 座標で読む
//     認定    利用者管理 → CSV
//   同じ人・同じ月について両方が持っている「要介護度」「区分支給限度基準額」が
//   食い違うなら、**どちらかが間違っている**。給付管理票の限度額は請求に直結する
//   ので、伝送に乗せる前に見つけたい。
//
//   ⚠ ここで出るのは「食い違い」であって、どちらが正しいかは判定しない。
//     利用票が古い (認定結果が出る前に出力した) ことも、CSV が古いこともある。
//
// ── 判定 ────────────────────────────────────────────────────────────────
//   対象月に有効な認定 = certification_start_date <= 月末 かつ
//                        (certification_end_date >= 月初 または NULL)
//   複数該当したら **開始日が新しいもの**を採る (区分変更は後の認定が有効)。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MONTH = process.env.MONTH ?? null;   // 未指定なら全月
const KAIGO = fileURLToPath(new URL("../", import.meta.url));

const env = {};
for (const l of readFileSync(path.join(KAIGO, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

async function fetchAll(build) {
  const out = [];
  // ⚠ order 無しで range を回すと行が重複・欠落する
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** "2026-06" → { first: "2026-06-01", last: "2026-06-30" } */
function monthRange(m) {
  const [y, mo] = m.split("-").map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();   // ⚠ toISOString は JST でずれるので UTC で組む
  return { first: `${m}-01`, last: `${m}-${String(last).padStart(2, "0")}` };
}

async function main() {
  console.log(`=== 利用票 vs 認定 の突き合わせ${MONTH ? ` (${MONTH})` : " (全月)"} — READ ONLY ===\n`);

  let q = () => sb.from("kaigo_report_documents")
    .select("id, user_id, report_month, content").eq("report_type", "service-usage");
  if (MONTH) { const m = MONTH; q = () => sb.from("kaigo_report_documents")
    .select("id, user_id, report_month, content").eq("report_type", "service-usage").eq("report_month", m); }
  const docs = await fetchAll(q);
  console.log(`利用票 ${docs.length} 件`);
  if (!docs.length) return;

  const certs = await fetchAll(() => sb.from("client_insurance_records")
    .select("client_id, care_level, service_limit_amount, certification_start_date, certification_end_date"));
  const byClient = new Map();
  for (const c of certs) {
    if (!byClient.has(c.client_id)) byClient.set(c.client_id, []);
    byClient.get(c.client_id).push(c);
  }
  const names = new Map((await fetchAll(() => sb.from("clients").select("id, name"))).map((c) => [c.id, c.name]));

  const out = { noCert: [], level: [], limit: [], noDocLevel: 0 };
  for (const d of docs) {
    const c = d.content ?? {};
    const { first, last } = monthRange(d.report_month);
    const rows = (byClient.get(d.user_id) ?? []).filter((r) =>
      r.certification_start_date && r.certification_start_date <= last &&
      (!r.certification_end_date || r.certification_end_date >= first));
    const nm = names.get(d.user_id) ?? d.user_id.slice(0, 8);
    if (!rows.length) { out.noCert.push(`${d.report_month} ${nm}`); continue; }
    // 区分変更は後の認定が有効
    rows.sort((a, b) => (b.certification_start_date ?? "").localeCompare(a.certification_start_date ?? ""));
    const cert = rows[0];
    if (!c.care_level) { out.noDocLevel++; continue; }
    if (c.care_level !== cert.care_level) {
      out.level.push(`${d.report_month} ${nm}  利用票=${c.care_level} / 認定=${cert.care_level}` +
        ` (${cert.certification_start_date}〜${cert.certification_end_date})`);
      continue;   // 要介護度が違えば限度額も違って当然。二重に数えない
    }
    if (c.limit_amount != null && cert.service_limit_amount != null &&
        Number(c.limit_amount) !== Number(cert.service_limit_amount)) {
      out.limit.push(`${d.report_month} ${nm}  ${c.care_level}  利用票=${c.limit_amount} / 認定=${cert.service_limit_amount}`);
    }
  }

  const show = (title, list, note) => {
    console.log(`\n★ ${title} — ${list.length} 件`);
    if (note) console.log(`   ${note}`);
    for (const s of list.slice(0, 25)) console.log(`   ${s}`);
    if (list.length > 25) console.log(`   … 他 ${list.length - 25} 件`);
  };
  show("利用票の月に有効な認定が無い", out.noCert,
    "認定の取込漏れか、認定期間が切れたまま。給付管理が立たない");
  show("要介護度が食い違う", out.level,
    "どちらが正かは判定しない。利用票が認定結果より前に出力されたことがある");
  show("区分支給限度基準額が食い違う", out.limit,
    "限度額は請求に直結する。旧改定額 (2019-10 より前) が残っていないか見る");
  if (out.noDocLevel) console.log(`\n  (利用票に要介護度が印字されていない ${out.noDocLevel} 件は判定から外した)`);

  // ── おまけ: 認定期間が重なっていて要介護度が違う人 ────────────────────
  //   区分変更をすると新しい認定が始まるが、**旧認定の終了日が切られていない**
  //   ことがある。対象月に有効な認定が 2 本立つので、どちらを採るかで
  //   単位数・限度額が変わる。
  //
  //   ⚠ アプリの resolveCertForMonth は「certification_start_date が最新」を
  //     採るので **請求は正しく出る**。ここで出すのはデータの掃除対象。
  const today = new Date();
  const asOf = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
  const overlaps = [];
  for (const [cid, rows] of byClient) {
    const rs = rows.filter((r) => r.certification_start_date);
    for (let i = 0; i < rs.length; i++) {
      for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i], b = rs[j];
        const ae = a.certification_end_date ?? "9999-12-31", be = b.certification_end_date ?? "9999-12-31";
        if (a.care_level === b.care_level) continue;
        if (a.certification_start_date > be || b.certification_start_date > ae) continue;
        if (ae < asOf || be < asOf) continue;   // 今も両方有効なものだけ
        const [older, newer] = a.certification_start_date <= b.certification_start_date ? [a, b] : [b, a];
        overlaps.push(`${names.get(cid) ?? cid.slice(0, 8)}  旧 ${older.certification_start_date}〜${older.certification_end_date} ${older.care_level}` +
          `  →  新 ${newer.certification_start_date}〜${newer.certification_end_date} ${newer.care_level}` +
          `  (旧の終了日を ${newer.certification_start_date} の前日に切るべき)`);
      }
    }
  }
  show("いま有効な認定が 2 本あり要介護度が違う", overlaps,
    "区分変更で旧認定の終了日が切られていない。請求は「開始日が最新」を採るので正しく出るが、掃除の対象");

  console.log(`\n合計 ${out.noCert.length + out.level.length + out.limit.length} 件 (+ 認定の重なり ${overlaps.length} 名)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
