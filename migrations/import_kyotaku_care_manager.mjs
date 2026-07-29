// 居宅の介護支援専門員番号 (ケアマネ番号) を kaigo_care_plans.care_manager_number へ。
//   ソース = 利用者データ/全居宅/全居宅居宅サービス計.CSV (列: 居宅介護支援専門員番号)。
//     ※ サービス計は事業所番号(col21)を持つので事業所横断で一括取込可能。
//   突合キー = 被保番 + 保険者番号 → clients → active な kaigo_care_plans。
//   OFFICE_ID 指定でその居宅事業所の利用者だけ更新 (既定=大網居宅)。
//   node migrations/import_kyotaku_care_manager.mjs [--execute]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const OFFICE_ID = process.env.OFFICE_ID || "755e64de-1289-473f-9423-150a9a9268d4"; // 大網居宅
const SRC = "サービス実績データ/全居宅/202606/全居宅居宅サービス計.CSV";

function loadEnv() { const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8"); const e = {}; for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, ""); } return e; }
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sjis = new TextDecoder("shift_jis");
function pl(l){const o=[];let c="",q=false;for(let i=0;i<l.length;i++){const ch=l[i];if(q){if(ch==='"'){if(l[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}else{if(ch==='"')q=true;else if(ch===","){o.push(c);c="";}else c+=ch;}}o.push(c);return o;}
const padIns = (s) => (s || "").trim().replace(/\s/g, "").padStart(10, "0");
const padInsurer = (s) => (s || "").trim().replace(/\s/g, "").padStart(6, "0");
const key = (ins, insurer) => `${padIns(ins)}|${padInsurer(insurer)}`;

async function main() {
  console.log(`=== 居宅 ケアマネ番号取込 (office ${OFFICE_ID.slice(0, 8)}) ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  // ソース: 被保番|保険者 → ケアマネ番号
  const lines = sjis.decode(readFileSync(path.join(KAIGO, SRC))).split(/\r?\n/).filter((l) => l);
  const H = pl(lines[0]); const gi = (n) => H.indexOf(n);
  const iIns = gi("被保険者番号"), iInsurer = gi("保険者番号"), iCM = gi("居宅介護支援専門員番号");
  const cmByKey = new Map();
  for (const l of lines.slice(1)) { const c = pl(l); const cm = (c[iCM] || "").trim(); if (cm) cmByKey.set(key(c[iIns], c[iInsurer]), cm); }
  console.log(`ソース ケアマネ番号: ${cmByKey.size} キー`);

  // 対象事業所の利用者 → clients (被保番|保険者)
  const { data: assigns } = await sb.from("client_office_assignments").select("client_id").eq("office_id", OFFICE_ID);
  const ids = assigns.map((a) => a.client_id);
  const cmByClient = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const { data: cs } = await sb.from("clients").select("id, insured_number, insurer_number").in("id", ids.slice(i, i + 200));
    for (const c of cs) { const cm = cmByKey.get(key(c.insured_number, c.insurer_number)); if (cm) cmByClient.set(c.id, cm); }
  }
  console.log(`利用者 ${ids.length} / ケアマネ突合 ${cmByClient.size}`);

  // active な care_plan を取得し差分算出
  let plans = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from("kaigo_care_plans").select("id, user_id, care_manager_number").in("user_id", ids.slice(i, i + 200)).eq("status", "active");
    plans.push(...data);
  }
  let upd = 0, same = 0, nomatch = 0;
  const updates = [];
  for (const p of plans) {
    const cm = cmByClient.get(p.user_id);
    if (!cm) { nomatch++; continue; }
    if (p.care_manager_number === cm) { same++; continue; }
    updates.push({ id: p.id, cm });
  }
  console.log(`\n更新対象 ${updates.length} / 既に一致 ${same} / ケアマネ無し ${nomatch} (active plan ${plans.length})`);
  updates.slice(0, 5).forEach((u) => console.log(`   ${u.id.slice(0, 8)} → ${u.cm}`));

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で更新。"); return; }
  for (const u of updates) {
    const { error } = await sb.from("kaigo_care_plans").update({ care_manager_number: u.cm }).eq("id", u.id);
    if (error) { console.error(`✗ ${u.id}: ${error.message}`); if (/care_manager_number/.test(error.message)) { console.error("→ 先に migration (kyotaku_care_manager_number.sql) を適用してください"); process.exit(1); } continue; }
    upd++;
  }
  console.log(`更新完了: ${upd} 件`);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
