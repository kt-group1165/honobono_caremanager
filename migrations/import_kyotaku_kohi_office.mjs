// 居宅の公費(生活保護 法別12)を client_kohi_records へ (全事業所汎用)。
//   STEP1(import_kyotaku_office)は公費を入れないため、公費単独(H番号)利用者で
//   伝送警告(公費番号未登録)が出る。公費全居宅.CSV から当月有効の生保公費を投入。
//   負担者番号 = 法別12 + 実施機関6桁 (公費全居宅 col3)。受給者=col4。
//   突合キー = 利用者番号 → 当事業所 client (DB user_number)。
//   OFFICE_ID=<uuid> TAG=<略称> node migrations/import_kyotaku_kohi_office.mjs [--execute]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const OFFICE_ID = process.env.OFFICE_ID, TAG = process.env.TAG || "";
if (!OFFICE_ID) { console.error("OFFICE_ID が必要"); process.exit(1); }
const CSV = "利用者データ/全居宅/公費全居宅.CSV";
const MONTH_START = "2026-06-01", MONTH_END = "2026-06-30", MARK = `[居宅公費 2026-06 ${TAG}]`;

function loadEnv() { const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8"); const e = {}; for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, ""); } return e; }
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sjis = new TextDecoder("shift_jis");
function pl(l){const o=[];let c="",q=false;for(let i=0;i<l.length;i++){const ch=l[i];if(q){if(ch==='"'){if(l[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}else{if(ch==='"')q=true;else if(ch===","){o.push(c);c="";}else c+=ch;}}o.push(c);return o;}
const iso = (s) => { const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((s || "").trim()); return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null; };

async function main() {
  console.log(`=== 居宅公費取込 (${TAG}) ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);
  const rows = sjis.decode(readFileSync(path.join(KAIGO, CSV))).split(/\r?\n/).filter((l) => l).map(pl);
  const H = rows[0]; const gi = (n) => H.indexOf(n);
  const iUser = gi("利用者番号"), iFutan = gi("負担者番号"), iJukyu = gi("受給者番号"), iKubun = gi("生活保護区分"),
    iCs = gi("有効期限－開始日"), iCe = gi("有効期限－終了日"), iHonnin = gi("本人支払額");
  // 利用者番号 → 当月有効の公費 (1件)
  const byUser = new Map();
  for (const c of rows.slice(1)) {
    const cs = iso(c[iCs]), ce = iso(c[iCe]);
    if (!(cs && ce && cs <= MONTH_END && ce >= MONTH_START)) continue;
    const u = (c[iUser] || "").trim(); if (!u || byUser.has(u)) continue;
    const futan6 = (c[iFutan] || "").trim().replace(/\D/g, "");
    byUser.set(u, {
      futansha: futan6.length === 6 ? "12" + futan6 : futan6.padStart(8, "0"), // 法別12 + 実施機関6桁
      jukyusha: (c[iJukyu] || "").trim(), start: cs, end: ce,
      honnin: Number((c[iHonnin] || "0").replace(/\D/g, "")) || 0, tandoku: (c[iKubun] || "").includes("単独"),
    });
  }
  console.log(`公費全居宅 当月有効: ${byUser.size} 利用者`);

  // 当事業所の client (user_number → id)
  const { data: as } = await sb.from("client_office_assignments").select("client_id").eq("office_id", OFFICE_ID);
  const ids = as.map((a) => a.client_id);
  const rowsToInsert = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data: cs } = await sb.from("clients").select("id, user_number, name, insured_number").in("id", ids.slice(i, i + 200));
    for (const c of cs) {
      const k = byUser.get(String(c.user_number));
      if (!k) continue;
      rowsToInsert.push({ client_id: c.id, name: c.name, ...k });
    }
  }
  console.log(`当事業所の公費対象: ${rowsToInsert.length} 名 (うち生保単独 ${rowsToInsert.filter((r) => r.tandoku).length})`);
  rowsToInsert.slice(0, 6).forEach((r) => console.log(`  ${r.name}: 負担${r.futansha} 受給${r.jukyusha} 本人${r.honnin}${r.tandoku ? " [単独]" : ""}`));
  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で client_kohi_records 投入 (既存 marker 分は削除→再投入)。"); return; }

  const cids = rowsToInsert.map((r) => r.client_id);
  for (let i = 0; i < cids.length; i += 100) await sb.from("client_kohi_records").delete().eq("kohi_hobetsu", "12").in("client_id", cids.slice(i, i + 100)).eq("notes", MARK);
  let ins = 0;
  for (const r of rowsToInsert) {
    const { error } = await sb.from("client_kohi_records").insert({
      tenant_id: "kt-group", client_id: r.client_id, kohi_hobetsu: "12", futansha_number: r.futansha, jukyusha_number: r.jukyusha,
      start_date: r.start, end_date: r.end, priority: 1, honnin_futan: r.honnin, notes: MARK,
    });
    if (error) { console.error(`✗ ${r.name}: ${error.message}`); continue; }
    ins++;
  }
  console.log(`投入 ${ins} 件`);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
