/**
 * 茂原 障害 shougai_certifications.insurer_municipality を
 * ほのぼの伝送(KJ260701)の市町村番号6桁で backfill する。
 *   - cert_number(受給者証番号) で 伝送の市町村番号に直接紐付け (伝送=正解)
 *   - 伝送に無い cert は 市名→6桁 table (伝送から導出) で補完
 * 対象 = marker '[ほのぼの取込 2026-07-17 茂原身障]' の cert のみ
 * Usage: node migrations/backfill_shougai_shicho_moba.mjs [--execute]
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
const __d = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(readFileSync(join(__d,"..",".env.local"),"utf8")
  .split("\n").map(l=>l.match(/^([^=]+)=(.+)$/)).filter(Boolean)
  .map(m=>[m[1].trim(),m[2].trim().replace(/^["']|["']$/g,"")]));
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const EXECUTE = process.argv.includes("--execute");
const MARKER = "[ほのぼの取込 2026-07-17 茂原身障]";

// cert -> 市町村番号 (伝送 KJ から抽出済)
const certShi = JSON.parse(readFileSync(join(__d,"_moba_cert_shi.json"),"utf8"));
// 市名 -> 6桁 (伝送から導出) : parse 出力の cert->city を突合
const parse = JSON.parse(readFileSync(join(__d,"shougai_import_moba.json"),"utf8"));
const cityCode = {};
for (const c of parse.clients) {
  for (const e of (c.current_certs||[])) {
    const shi = certShi[e.cert_number];
    if (shi && e.city) cityCode[e.city] = shi;
  }
}
console.log("市名→6桁:", JSON.stringify(cityCode, null, 0));

// 茂原 marker cert を取得
const { data: certs, error } = await sb.from("shougai_certifications")
  .select("id, beneficiary_number, insurer_municipality, notes")
  .like("notes", `${MARKER}%`);
if (error) { console.error("❌ cert 取得:", error.message); process.exit(1); }
console.log(`対象 cert: ${certs.length} 件`);

let plan = [], skip = 0;
for (const c of certs) {
  const cur = c.insurer_municipality;
  let code = certShi[c.beneficiary_number] || null;
  let via = "伝送cert";
  if (!code) {
    // 市名で補完 (現値がテキスト市名の場合)
    code = cityCode[cur] || null; via = "市名";
  }
  if (!code) { console.warn(`  ⚠ 解決不能: cert=${c.beneficiary_number} 現値=${cur}`); continue; }
  if (cur === code) { skip++; continue; }
  plan.push({ id: c.id, cert: c.beneficiary_number, from: cur, to: code, via });
}
console.log(`\n📊 更新予定 ${plan.length} 件 / 既に6桁一致 ${skip} 件`);
for (const p of plan) console.log(`  ${p.cert}: ${p.from} → ${p.to} (${p.via})`);

if (!EXECUTE) { console.log("\n🔍 DRY RUN (--execute で更新)"); process.exit(0); }
let ok=0,ng=0;
for (const p of plan) {
  const { error } = await sb.from("shougai_certifications")
    .update({ insurer_municipality: p.to }).eq("id", p.id);
  if (error) { console.error(`  ✗ ${p.cert}: ${error.message}`); ng++; } else ok++;
}
console.log(`\n✅ 更新 ${ok} / 失敗 ${ng}`);
