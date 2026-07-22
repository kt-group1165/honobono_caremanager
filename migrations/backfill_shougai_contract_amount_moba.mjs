/**
 * 茂原 障害 shougai_certifications.contract_amount_text を
 * 受給者証の支給量(shikyuryo_details)から backfill。
 *   フォーマット = parseContractAmounts(build.ts)が読める「身体80 家事5 通院25」(時間)。
 *   ※契約支給量の正は事業所との契約だが、未入力のため支給決定量を既定値として充当。
 *     ほのぼの契約量と差がある場合は受給者証ページで個別修正可。
 * 対象 = marker '[ほのぼの取込 2026-07-17 茂原身障]' かつ contract_amount_text=null
 * Usage: node migrations/backfill_shougai_contract_amount_moba.mjs [--execute]
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
const __d = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(readFileSync(join(__d,"..",".env.local"),"utf8").split("\n").map(l=>l.match(/^([^=]+)=(.+)$/)).filter(Boolean).map(m=>[m[1].trim(),m[2].trim().replace(/^["']|["']$/g,"")]));
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const EXECUTE = process.argv.includes("--execute");
const MARKER = "[ほのぼの取込 2026-07-17 茂原身障]";

// shikyuryo_details キー → 契約テキストのカテゴリ語 (parseContractAmounts が読む語)
const CAT = { "身体介護":"身体", "家事援助":"家事", "生活援助":"家事", "通院身体":"通院", "通院家事":"通院", "乗降":"乗降" };

const { data: certs, error } = await sb.from("shougai_certifications")
  .select("id, beneficiary_number, shikyuryo_details, contract_amount_text")
  .like("notes", `${MARKER}%`);
if (error) { console.error("❌", error.message); process.exit(1); }

let plan = [], skip = 0;
for (const c of certs) {
  if (c.contract_amount_text) { skip++; continue; }
  const d = c.shikyuryo_details || {};
  const parts = [];
  for (const [k, v] of Object.entries(d)) {
    const cat = CAT[k];
    if (!cat || !v || typeof v !== "object") continue;
    let hours = null;
    if (v.hours != null) hours = v.hours + (v.minutes ? v.minutes / 60 : 0);
    else if (v.count != null) continue; // 回数系は契約テキスト対象外
    if (hours == null) continue;
    const hstr = Number.isInteger(hours) ? String(hours) : hours.toFixed(2).replace(/0+$/,"").replace(/\.$/,"");
    parts.push(`${cat}${hstr}`);
  }
  if (!parts.length) { console.warn(`  ⚠ 支給量なし: ${c.beneficiary_number}`); continue; }
  plan.push({ id: c.id, cert: c.beneficiary_number, text: parts.join(" ") });
}
console.log(`📊 更新予定 ${plan.length} / 既入力skip ${skip}`);
for (const p of plan) console.log(`  ${p.cert}: "${p.text}"`);

if (!EXECUTE) { console.log("\n🔍 DRY RUN (--execute で更新)"); process.exit(0); }
let ok=0,ng=0;
for (const p of plan) {
  const { error } = await sb.from("shougai_certifications").update({ contract_amount_text: p.text }).eq("id", p.id);
  if (error) { console.error(`  ✗ ${p.cert}: ${error.message}`); ng++; } else ok++;
}
console.log(`\n✅ 更新 ${ok} / 失敗 ${ng}`);
