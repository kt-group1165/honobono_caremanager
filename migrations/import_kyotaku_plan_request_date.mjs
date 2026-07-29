// 大網居宅: 大網2026_06.CSV の「届出日」→ kaigo_care_plans.plan_request_date
//   (計画作成依頼届出年月日。居宅介護支援費明細書 8121 項15)。
//   キー = 被保番 (居宅マッピング _kyotaku_num_to_client_大網.json)。
//   node migrations/import_kyotaku_plan_request_date.mjs [--execute]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
function loadEnv() { const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8"); const e = {}; for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, ""); } return e; }
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sjis = new TextDecoder("shift_jis");
function pl(l){const o=[];let c="",q=false;for(let i=0;i<l.length;i++){const ch=l[i];if(q){if(ch==='"'){if(l[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}else{if(ch==='"')q=true;else if(ch===","){o.push(c);c="";}else c+=ch;}}o.push(c);return o;}
const iso = (s) => { const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((s || "").trim()); return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null; };

async function main() {
  console.log(`=== 居宅 届出日取込 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);
  const lines = sjis.decode(readFileSync(path.join(KAIGO, "サービス実績データ/大網/居宅/202606/202606/大網2026_06.CSV"))).split(/\r?\n/).filter((l) => l);
  const H = pl(lines[0]); const gi = (n) => H.indexOf(n);
  const iIns = gi("被保険者番号"), iTod = gi("届出日");
  const byIns = new Map();
  for (const l of lines.slice(1)) { const c = pl(l); const ins = (c[iIns] || "").trim(); const d = iso(c[iTod]); if (ins && d && !byIns.has(ins)) byIns.set(ins, d); }
  console.log(`届出日あり: ${byIns.size}名 (被保番)`);

  const map = JSON.parse(readFileSync(path.join(KAIGO, "migrations/_kyotaku_num_to_client_大網.json"), "utf8"));
  let upd = 0, nodate = 0;
  for (const [ins, cid] of Object.entries(map)) {
    const d = byIns.get(ins);
    if (!d) { nodate++; continue; }
    if (!EXECUTE) { upd++; continue; }
    const { error, count } = await sb.from("kaigo_care_plans").update({ plan_request_date: d }, { count: "exact" }).eq("user_id", cid).eq("status", "active");
    if (error) { console.error(`✗ ${ins}: ${error.message}`); if (/plan_request_date/.test(error.message)) { console.error("→ 先に migration (kyotaku_plan_request_date.sql) を適用してください"); process.exit(1); } }
    else if (count > 0) upd++;
  }
  console.log(`${EXECUTE ? "更新" : "対象"}: ${upd}名 / 届出日なし ${nodate}`);
  if (!EXECUTE) console.log("※ DRY RUN。--execute で更新。");
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
