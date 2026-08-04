// 居宅の給付管理票 8221 終端行に必要な「区分支給限度基準額」を
//   client_insurance_records.service_limit_amount に取り込む。
//   ソース = 利用者データ/全居宅/介護保険 全居宅.CSV (列: 区分支給限度基準額（居宅ｻｰﾋﾞｽ区分）)。
//   突合キー = 被保番 + 保険者番号。対象月 (2026-06) を含む認定行を採用。
//   OFFICE_ID 指定でその居宅事業所の利用者だけ更新 (既定=大網居宅)。
//   node migrations/update_kyotaku_limit_amount.mjs [--execute]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const OFFICE_ID = process.env.OFFICE_ID || "755e64de-1289-473f-9423-150a9a9268d4"; // 大網居宅
const MASTER = "利用者データ/全居宅/介護保険 全居宅.CSV";
const MONTH_START = "2026-06-01", MONTH_END = "2026-06-30";

function loadEnv() { const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8"); const e = {}; for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, ""); } return e; }
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sjis = new TextDecoder("shift_jis");
function pl(l){const o=[];let c="",q=false;for(let i=0;i<l.length;i++){const ch=l[i];if(q){if(ch==='"'){if(l[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}else{if(ch==='"')q=true;else if(ch===","){o.push(c);c="";}else c+=ch;}}o.push(c);return o;}
const iso = (s) => { const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((s || "").trim()); return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null; };
const padIns = (s) => (s || "").trim().replace(/\s/g, "").padStart(10, "0");
const padInsurer = (s) => (s || "").trim().replace(/\s/g, "").padStart(6, "0");
const key = (ins, insurer) => `${padIns(ins)}|${padInsurer(insurer)}`;

async function main() {
  console.log(`=== 居宅 限度額取込 (office ${OFFICE_ID.slice(0, 8)}) ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  // マスタ: 被保番|保険者 → 対象月を含む認定済み行の限度額
  const lines = sjis.decode(readFileSync(path.join(KAIGO, MASTER))).split(/\r?\n/).filter((l) => l);
  const H = pl(lines[0]); const gi = (n) => H.indexOf(n);
  const iIns = gi("被保険者番号"), iInsurer = gi("保険者番号"), iLimit = gi("区分支給限度基準額（居宅ｻｰﾋﾞｽ区分）"),
    iCertS = gi("認定有効期間－開始日"), iCertE = gi("認定有効期間－終了日");
  const limByKey = new Map();
  for (const l of lines.slice(1)) {
    const c = pl(l);
    const lim = Number((c[iLimit] || "").replace(/[^\d]/g, "")) || 0;
    if (!lim) continue;
    const cs = iso(c[iCertS]), ce = iso(c[iCertE]);
    // 対象月を含む認定を優先 (無ければ最後の行)
    const covers = cs && ce && cs <= MONTH_END && ce >= MONTH_START;
    const k = key(c[iIns], c[iInsurer]);
    const cur = limByKey.get(k);
    if (!cur || (covers && !cur.covers)) limByKey.set(k, { lim, covers, cs, ce });
  }
  console.log(`マスタ限度額: ${limByKey.size} キー`);

  // 対象事業所の利用者 → client_insurance_records
  const { data: assigns } = await sb.from("client_office_assignments").select("client_id").eq("office_id", OFFICE_ID);
  const ids = assigns.map((a) => a.client_id);
  let recs = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from("client_insurance_records").select("id, client_id, insured_number, insurer_number, service_limit_amount, certification_start_date, certification_end_date").in("client_id", ids.slice(i, i + 200));
    recs.push(...data);
  }
  console.log(`対象認定レコード: ${recs.length} 件 (利用者 ${ids.length})`);

  let upd = 0, nomaster = 0, same = 0;
  const updates = [];
  for (const r of recs) {
    const k = key(r.insured_number, r.insurer_number);
    const m = limByKey.get(k);
    if (!m) { nomaster++; continue; }
    if (r.service_limit_amount === m.lim) { same++; continue; }
    updates.push({ id: r.id, lim: m.lim, was: r.service_limit_amount });
  }
  console.log(`\n更新対象 ${updates.length} / 既に一致 ${same} / マスタ無し ${nomaster}`);
  updates.slice(0, 5).forEach((u) => console.log(`   ${u.id.slice(0, 8)}: ${u.was ?? "null"} → ${u.lim}`));

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で更新。"); return; }
  for (const u of updates) {
    const { error } = await sb.from("client_insurance_records").update({ service_limit_amount: u.lim }).eq("id", u.id);
    if (error) { console.error(`✗ ${u.id}: ${error.message}`); continue; }
    upd++;
  }
  console.log(`更新完了: ${upd} 件`);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
