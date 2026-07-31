// 居宅介護支援費レセプトの利用者別加算を KK260702(8124) から投入し、処遇改善・合計を再計算。
//   一括生成は利用者別加算(初回/入院/退院/通院/ターミナル)を全てOFFで作るため、
//   ケアマネ入力である加算の有無を ほのぼの KK(居宅支援費明細書) から反映する。
//   加算単位は KK 明細の実単位を使用。処遇 = round((base+特定+加算)×permil/1000)。
//   OFFICE_ID=<uuid> TAG=<略称> KK=<KK260702パス> node migrations/import_kyotaku_addon_from_kk.mjs [--execute]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const OFFICE_ID = process.env.OFFICE_ID, TAG = process.env.TAG, KK = process.env.KK;
if (!OFFICE_ID || !TAG || !KK) { console.error("OFFICE_ID / TAG / KK が必要"); process.exit(1); }
function loadEnv() { const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8"); const e = {}; for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, ""); } return e; }
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sjis = new TextDecoder("shift_jis");
function pl(l){const o=[];let c="",q=false;for(let i=0;i<l.length;i++){const ch=l[i];if(q){if(ch==='"'){if(l[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}else{if(ch==='"')q=true;else if(ch===","){o.push(c);c="";}else c+=ch;}}o.push(c);return o;}
const padIns = (s) => (s || "").trim().replace(/\s/g, "").padStart(10, "0");
const padInsurer = (s) => (s || "").trim().replace(/\s/g, "").padStart(6, "0");
// 退院退所 discharge_type (claims-shared.ts 準拠)
const DISCHARGE_TYPE = { "436132": "i_i", "436143": "i_ii", "436144": "ii_i" };

async function main() {
  console.log(`=== 居宅加算取込 (KKより) (${TAG}) ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);
  const { data: off } = await sb.from("offices").select("unit_price, care_support_shoguu_permil, care_support_shoguu_code").eq("id", OFFICE_ID);
  const unitPrice100 = Math.round(Number(off[0].unit_price) * 100);
  const permil = Number(off[0].care_support_shoguu_permil) || 0;
  const shoguuCode = off[0].care_support_shoguu_code || "436191";
  console.log(`単価 ${off[0].unit_price} / 処遇 ${permil}‰`);

  // KK260702 8124: per user の 加算 と 合計(行99)
  const rows = sjis.decode(readFileSync(path.isAbsolute(KK) ? KK : path.join(KAIGO, KK))).split(/\r?\n/).filter((l) => l).map(pl).filter((r) => r[2] === "8124");
  const byUser = new Map();
  for (const r of rows) {
    const k = `${padIns(r[8])}|${padInsurer(r[6])}`;
    if (!byUser.has(k)) byUser.set(k, { init: 0, hosp: 0, disc: 0, discType: null, medco: 0, medco2: 0, term: 0, emg: 0, total: 0, req: 0 });
    const e = byUser.get(k);
    const code = r[18], units = Number(r[19] || 0) || 0;
    if (r[17] === "99") { e.total = Number(r[22] || 0) || 0; e.req = Number(r[23] || 0) || 0; } // 行99: 項21合計単位(idx22)/項22請求(idx23)
    if (code === "434001") e.init = units;
    else if (code === "434005") e.medco = units;
    else if (code === "436125" || code === "436129") e.hosp = units;
    else if (code === "436135") e.medco2 = units;
    else if (code === "436100") e.term = units;
    else if (code === "436133") e.emg = units;
    else if (DISCHARGE_TYPE[code]) { e.disc = units; e.discType = DISCHARGE_TYPE[code]; }
  }
  const withAddon = [...byUser.values()].filter((v) => v.init || v.hosp || v.disc || v.medco || v.medco2 || v.term || v.emg);
  console.log(`KK加算あり利用者: ${withAddon.length}名`);

  // 当事業所の利用者を DB から取得し 被保番|保険者 → client_id
  const { data: as } = await sb.from("client_office_assignments").select("client_id").eq("office_id", OFFICE_ID);
  const ids = as.map((a) => a.client_id);
  const byClient = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const { data: cs } = await sb.from("clients").select("id, insured_number, insurer_number").in("id", ids.slice(i, i + 200));
    for (const c of cs) { const k = `${padIns(c.insured_number)}|${padInsurer(c.insurer_number)}`; if (byUser.has(k)) byClient.set(c.id, byUser.get(k)); }
  }
  let claims = [];
  for (let i = 0; i < ids.length; i += 200) { const { data } = await sb.from("kaigo_care_support_claims").select("*").eq("billing_month", "2026-06").in("user_id", ids.slice(i, i + 200)); claims.push(...data); }

  let upd = 0, diffTotal = 0; const mism = [];
  for (const c of claims) {
    const a = byClient.get(c.user_id) || { init: 0, hosp: 0, disc: 0, medco: 0, medco2: 0, term: 0, emg: 0, discType: null };
    const base = c.units || 0; // units 列 = 居宅介護支援費本体 (要介護度別・逓減反映済)。特定/処遇は別列
    const addonSum = a.init + a.hosp + a.disc + a.medco + a.medco2 + a.term + a.emg;
    const subtotal = base + (c.tokutei_kassan_units || 0) + addonSum;
    const shoguu = Math.round((subtotal * permil) / 1000);
    const newUnits = subtotal + shoguu;
    const newTotal = Math.floor((newUnits * unitPrice100) / 100);
    // KK合計と照合 (加算あり利用者のみ意味あり)
    const kkTotal = byClient.has(c.user_id) ? a.req : null;
    if (kkTotal != null && kkTotal !== newTotal) { diffTotal++; if (mism.length < 8) mism.push(`user ${c.user_id.slice(0, 8)}: 計算${newTotal} vs KK${kkTotal}`); }
    if (!EXECUTE) continue;
    const patch = {
      initial_addition: a.init > 0, initial_addition_units: a.init || 0,
      hospital_coordination: a.hosp > 0, hospital_coordination_units: a.hosp || 0,
      discharge_addition: a.disc > 0, discharge_addition_units: a.disc || 0, discharge_type: a.discType,
      medical_coop_kassan: a.medco > 0, medical_coop_kassan_units: a.medco || 0,
      // 通院時情報連携加算 (436135)。合計に入れ忘れて2名の請求額が 556円 不足していた
      medical_coordination: a.medco2 > 0, medical_coordination_units: a.medco2 || 0,
      terminal_care: a.term > 0, terminal_care_units: a.term || 0,
      emergency_conference: a.emg > 0, emergency_conference_units: a.emg || 0,
      shoguu_kaizen_units: shoguu, shoguu_kaizen_code: shoguuCode, total_amount: newTotal, insurance_amount: newTotal,
      unit_price: Number(off[0].unit_price), // 単価も office 設定に正す (10→10.21/11.05 の破損補正)
    };
    const { error } = await sb.from("kaigo_care_support_claims").update(patch).eq("id", c.id);
    if (error) { console.error(`✗ ${c.id}: ${error.message}`); continue; }
    upd++;
  }
  console.log(`${EXECUTE ? "更新" : "対象"} ${EXECUTE ? upd : claims.length}件 / KK合計不一致 ${diffTotal}件`);
  mism.forEach((m) => console.log("  ", m));
  if (!EXECUTE) console.log("\n※ DRY RUN。--execute で加算投入+処遇/合計再計算。");
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
