// 居宅の認定情報を最新に同期 (全事業所汎用)。STEP1の既存再利用clientは認定を更新
//   しないため、要介護度/認定期間/限度額 が旧値のまま残る (市原=要介護2旧、限度額null等)。
//   サービス計(要介護度・認定期間) + 介護保険全居宅(限度額) を正として、当事業所の
//   全clientの client_insurance_records + clients.care_level を上書き同期する。
//   OFFICE_ID=<uuid> node migrations/import_kyotaku_insurance_sync.mjs [--execute]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const OFFICE_ID = process.env.OFFICE_ID, OFFICE_BN = process.env.OFFICE_BN;
if (!OFFICE_ID || !OFFICE_BN) { console.error("OFFICE_ID / OFFICE_BN が必要"); process.exit(1); }
const MONTH_START = "2026-06-01", MONTH_END = "2026-06-30";
function loadEnv() { const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8"); const e = {}; for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, ""); } return e; }
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sjis = new TextDecoder("shift_jis");
function pl(l){const o=[];let c="",q=false;for(let i=0;i<l.length;i++){const ch=l[i];if(q){if(ch==='"'){if(l[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}else{if(ch==='"')q=true;else if(ch===","){o.push(c);c="";}else c+=ch;}}o.push(c);return o;}
const iso = (s) => { const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((s || "").trim()); return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null; };
const careNorm = (s) => (s || "").normalize("NFKC").replace(/\s/g, "");
const key = (ins, insurer) => `${(ins || "").trim()}|${(insurer || "").trim()}`;

async function main() {
  console.log(`=== 居宅 認定同期 (${OFFICE_BN}) ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);
  // サービス計: 被保|保険 → 要介護度・認定期間
  const kei = sjis.decode(readFileSync(path.join(KAIGO, "サービス実績データ/全居宅/202606/全居宅居宅サービス計.CSV"))).split(/\r?\n/).filter((l) => l).map(pl);
  const Hk = kei[0]; const gk = (n) => Hk.indexOf(n);
  const src = new Map();
  for (const c of kei.slice(1)) {
    if ((c[gk("居宅介護支援事業所番号")] || "").trim() !== OFFICE_BN) continue;
    const k = key(c[gk("被保険者番号")], c[gk("保険者番号")]);
    if (!src.has(k)) src.set(k, { care: careNorm(c[gk("要介護度")]), cs: iso(c[gk("認定期間（開始）")]), ce: iso(c[gk("認定期間（終了）")]) });
  }
  // 介護保険全居宅: 被保|保険 → 限度額 (当月有効優先)
  const hoken = sjis.decode(readFileSync(path.join(KAIGO, "利用者データ/全居宅/介護保険 全居宅.CSV"))).split(/\r?\n/).filter((l) => l).map(pl);
  const Hh = hoken[0]; const gh = (n) => Hh.indexOf(n);
  const lim = new Map();
  for (const c of hoken.slice(1)) {
    const l = Number((c[gh("区分支給限度基準額（居宅ｻｰﾋﾞｽ区分）")] || "").replace(/\D/g, "")) || 0; if (!l) continue;
    const cs = iso(c[gh("認定有効期間－開始日")]), ce = iso(c[gh("認定有効期間－終了日")]);
    const covers = cs && ce && cs <= MONTH_END && ce >= MONTH_START;
    const k = key(c[gh("被保険者番号")], c[gh("保険者番号")]); const cur = lim.get(k);
    if (!cur || (covers && !cur.covers)) lim.set(k, { l, covers });
  }

  const { data: as } = await sb.from("client_office_assignments").select("client_id").eq("office_id", OFFICE_ID);
  const ids = as.map((a) => a.client_id);
  let recs = [];
  for (let i = 0; i < ids.length; i += 200) { const { data } = await sb.from("client_insurance_records").select("id, client_id, insured_number, insurer_number, care_level, service_limit_amount, certification_start_date, certification_end_date").in("client_id", ids.slice(i, i + 200)); recs.push(...data); }
  let upd = 0; const changes = [];
  for (const r of recs) {
    const k = key(r.insured_number, r.insurer_number); const s = src.get(k); const lm = lim.get(k);
    if (!s && !lm) continue;
    const patch = {};
    if (s?.care && s.care !== r.care_level) patch.care_level = s.care;
    if (s?.cs && s.cs !== r.certification_start_date) patch.certification_start_date = s.cs;
    if (s?.ce && s.ce !== r.certification_end_date) patch.certification_end_date = s.ce;
    if (lm?.l && lm.l !== r.service_limit_amount) patch.service_limit_amount = lm.l;
    if (Object.keys(patch).length === 0) continue;
    changes.push({ id: r.id, client_id: r.client_id, patch });
  }
  console.log(`同期対象: ${changes.length}名`);
  for (const c of changes.slice(0, 10)) console.log(`  ${c.client_id.slice(0, 8)}: ${JSON.stringify(c.patch)}`);
  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で insurance + clients.care_level を同期。"); return; }
  for (const c of changes) {
    await sb.from("client_insurance_records").update(c.patch).eq("id", c.id);
    if (c.patch.care_level) await sb.from("clients").update({ care_level: c.patch.care_level }).eq("id", c.client_id);
    upd++;
  }
  console.log(`同期完了: ${upd}名`);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
