// 給付管理データ取込 (全事業所汎用): 全居宅事業所別請求額.CSV → kaigo_benefit_management。
//   給付管理単位 = 提供事業所×サービス種類ごとの Σ(サービス単位数×回数)。
//   「支給限度額対象外」除外 / 0単位グループ除外 / 同一コードで明細併存する明細・小計除外。
//   突合キー = 被保番+保険者 (居宅STEP1 の _kyotaku_office_map_<TAG>.json)。
//   OFFICE_BN=<支援事業所番号> OFFICE_ID=<uuid> TAG=<略称> \
//     node migrations/import_kyotaku_benefit_office.mjs [--execute]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const OFFICE_BN = process.env.OFFICE_BN, OFFICE_ID = process.env.OFFICE_ID, TAG = process.env.TAG || OFFICE_BN;
if (!OFFICE_BN || !OFFICE_ID) { console.error("OFFICE_BN と OFFICE_ID が必要"); process.exit(1); }
const CSV = "サービス実績データ/全居宅/202606/全居宅事業所別請求額.CSV";
const BILLING_MONTH = "2026-06";

function loadEnv() { const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8"); const e = {}; for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, ""); } return e; }
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sjis = new TextDecoder("shift_jis");
function pl(l){const o=[];let c="",q=false;for(let i=0;i<l.length;i++){const ch=l[i];if(q){if(ch==='"'){if(l[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}else{if(ch==='"')q=true;else if(ch===","){o.push(c);c="";}else c+=ch;}}o.push(c);return o;}
const padIns = (s) => (s || "").trim().replace(/\s/g, "").padStart(10, "0");
const padInsurer = (s) => (s || "").trim().replace(/\s/g, "").padStart(6, "0");
const key = (ins, insurer) => `${padIns(ins)}|${padInsurer(insurer)}`;

async function main() {
  console.log(`=== 給付管理取込 (${TAG} / ${OFFICE_BN}) ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);
  const lines = sjis.decode(readFileSync(path.join(KAIGO, CSV))).split(/\r?\n/).filter((l) => l);
  const H = pl(lines[0]); const gi = (n) => H.indexOf(n);
  const iSup = gi("事業所番号（支援事業所）"), iKind = gi("サービス種類コード（提供事業所）"), iKindName = gi("事業種別名（提供事業所）"),
    iProvNo = gi("事業所番号（提供事業所）"), iProvName = gi("事業所名（提供事業所）"), iUnit = gi("サービス単位／金額"),
    iIns = gi("被保険者番号"), iInsurer = gi("保険者番号"), iKubun = gi("サービス区分"), iCode = gi("サービスコード");

  const own = (c) => (c[iSup] || "").trim() === OFFICE_BN;
  const isOver = (c) => (c[iKubun] || "").trim() === "支給限度額対象外";
  const hasMeisai = new Set();
  for (const l of lines.slice(1)) { const c = pl(l); if (!own(c) || isOver(c)) continue; if ((c[iKubun] || "").trim() === "明細") hasMeisai.add(`${c[iIns]}|${c[iInsurer]}|${c[iProvNo]}|${c[iKind]}|${c[iCode]}`); }

  const agg = new Map();
  let over = 0, dup = 0;
  for (const l of lines.slice(1)) {
    const c = pl(l);
    if (!own(c)) continue;
    if (isOver(c)) { over++; continue; }
    if ((c[iKubun] || "").trim() === "明細・小計" && hasMeisai.has(`${c[iIns]}|${c[iInsurer]}|${c[iProvNo]}|${c[iKind]}|${c[iCode]}`)) { dup++; continue; }
    const k = `${key(c[iIns], c[iInsurer])}|${(c[iProvNo] || "").trim()}|${(c[iKind] || "").trim()}`;
    if (!agg.has(k)) agg.set(k, { units: 0, providerName: (c[iProvName] || "").trim(), serviceType: (c[iKindName] || "").trim(), ins: padIns(c[iIns]), insurer: padInsurer(c[iInsurer]), prov: (c[iProvNo] || "").trim(), kind: (c[iKind] || "").trim() });
    agg.get(k).units += Number(c[iUnit] || 0) || 0;
  }
  let zero = 0; for (const [k, v] of [...agg]) if (v.units === 0) { agg.delete(k); zero++; }
  console.log(`集計行 ${agg.size} / 対象外 ${over} / 小計重複 ${dup} / 0単位 ${zero}`);

  const map = JSON.parse(readFileSync(path.join(KAIGO, `migrations/_kyotaku_office_map_${TAG}.json`), "utf8"));
  const rows = []; const unmatched = new Set();
  for (const [, v] of agg) {
    const cid = map[`${v.ins}|${v.insurer}`];
    if (!cid) { unmatched.add(`${v.ins}|${v.insurer}`); continue; }
    rows.push({ user_id: cid, billing_month: BILLING_MONTH, service_type: v.serviceType, service_kind_code: v.kind, provider_name: v.providerName, provider_number: v.prov, planned_units: v.units, actual_units: v.units, over_limit_units: 0, status: "draft", tenant_id: "kt-group" });
  }
  console.log(`突合 ${rows.length}行 / ${new Set(rows.map(r => r.user_id)).size}名 / 未突合 ${unmatched.size}`);
  if (unmatched.size) console.log("  未突合:", [...unmatched].slice(0, 10));
  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で投入 (対象月既存を先に削除)。"); return; }

  const ids = [...new Set(Object.values(map))];
  let del = 0;
  for (let i = 0; i < ids.length; i += 200) { const { count } = await sb.from("kaigo_benefit_management").delete({ count: "exact" }).eq("billing_month", BILLING_MONTH).in("user_id", ids.slice(i, i + 200)); del += count || 0; }
  let ins = 0;
  for (let i = 0; i < rows.length; i += 200) { const { error } = await sb.from("kaigo_benefit_management").insert(rows.slice(i, i + 200)); if (error) { console.error("挿入失敗:", error.message); process.exit(1); } ins += rows.slice(i, i + 200).length; }
  console.log(`既存削除 ${del} / 挿入 ${ins} 完了`);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
