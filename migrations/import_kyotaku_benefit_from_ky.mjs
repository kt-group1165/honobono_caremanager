// 給付管理データ取込 (KY伝送 正本): ほのぼの KY260701 の 8222 → kaigo_benefit_management。
//   給付管理単位数はケアマネ入力 (限度額超過時の減単位調整を含む) であり計算値ではないため、
//   ほのぼのの給付管理票 (KY) を正本として取り込む。事業所別請求額の生単位では
//   限度額超過分の調整が表現されず不一致になる (おゆみ野15名で判明)。
//   service_type名/provider_名は事業所別請求額から補完 (表示用。伝送出力は
//   service_kind_code + provider_number を使うので必須ではない)。
//   突合キー = 被保番+保険者 (_kyotaku_office_map_<TAG>.json)。
//   OFFICE_ID=<uuid> TAG=<略称> KY=<KYファイルパス> \
//     node migrations/import_kyotaku_benefit_from_ky.mjs [--execute]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const OFFICE_ID = process.env.OFFICE_ID, TAG = process.env.TAG, KY = process.env.KY;
if (!OFFICE_ID || !TAG || !KY) { console.error("OFFICE_ID / TAG / KY が必要"); process.exit(1); }
const BILLING_MONTH = "2026-06", YM = "202606";

function loadEnv() { const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8"); const e = {}; for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, ""); } return e; }
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sjis = new TextDecoder("shift_jis");
function pl(l){const o=[];let c="",q=false;for(let i=0;i<l.length;i++){const ch=l[i];if(q){if(ch==='"'){if(l[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}else{if(ch==='"')q=true;else if(ch===","){o.push(c);c="";}else c+=ch;}}o.push(c);return o;}
const padIns = (s) => (s || "").trim().replace(/\s/g, "").padStart(10, "0");
const padInsurer = (s) => (s || "").trim().replace(/\s/g, "").padStart(6, "0");

async function main() {
  console.log(`=== 給付管理取込 (KY正本) (${TAG}) ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  // 名称補完: 事業所別請求額 (提供番号|種類 → serviceType名/provider名)
  const nameByKey = new Map();
  try {
    const rows = sjis.decode(readFileSync(path.join(KAIGO, "サービス実績データ/全居宅/202606/全居宅事業所別請求額.CSV"))).split(/\r?\n/).filter((l) => l).map(pl);
    const H = rows[0]; const gi = (n) => H.indexOf(n);
    const iProv = gi("事業所番号（提供事業所）"), iKind = gi("サービス種類コード（提供事業所）"), iKn = gi("事業種別名（提供事業所）"), iPn = gi("事業所名（提供事業所）");
    for (const c of rows.slice(1)) { const k = `${(c[iProv] || "").trim()}|${(c[iKind] || "").trim()}`; if (!nameByKey.has(k)) nameByKey.set(k, { serviceType: (c[iKn] || "").trim(), providerName: (c[iPn] || "").trim() }); }
  } catch { /* 名称補完なしでも可 */ }

  // KY 8222 (対象年月=YM・明細行のみ) を per (被保番|保険者, 提供番号, 種類) → planned_units
  const ky = sjis.decode(readFileSync(path.isAbsolute(KY) ? KY : path.join(KAIGO, KY))).split(/\r?\n/).filter((l) => l).map(pl).filter((r) => r[2] === "8222" && r[3] === YM && r[9] !== "99");
  const agg = new Map();
  for (const r of ky) {
    const ins = padIns(r[10]), insurer = padInsurer(r[4].replace(/^0+/, ""));
    const prov = (r[18] || "").trim(), kind = (r[20] || "").trim(), units = Number(r[21] || 0) || 0;
    // 項18 指定/基準該当/地域密着型サービス識別コード (1=指定/2=基準該当/5=地域密着型 等)。
    // 基準該当(2)等は種類コードから導出できないため KY の実値を保持する。
    const kubun = (r[19] || "").trim();
    const k = `${ins}|${insurer}|${prov}|${kind}`;
    if (!agg.has(k)) agg.set(k, { ins, insurer, prov, kind, kubun, units: 0 });
    agg.get(k).units += units;
  }
  console.log(`KY 8222 明細: ${agg.size} 行`);

  const map = JSON.parse(readFileSync(path.join(KAIGO, `migrations/_kyotaku_office_map_${TAG}.json`), "utf8"));
  const rows = []; const unmatched = new Set();
  for (const [, v] of agg) {
    const cid = map[`${v.ins}|${v.insurer}`];
    if (!cid) { unmatched.add(`${v.ins}|${v.insurer}`); continue; }
    const nm = nameByKey.get(`${v.prov}|${v.kind}`) || {};
    rows.push({ user_id: cid, billing_month: BILLING_MONTH, service_type: nm.serviceType || "", service_kind_code: v.kind, shitei_kubun: v.kubun || null, provider_name: nm.providerName || "", provider_number: v.prov, planned_units: v.units, actual_units: v.units, over_limit_units: 0, status: "draft", tenant_id: "kt-group" });
  }
  console.log(`突合 ${rows.length}行 / ${new Set(rows.map(r => r.user_id)).size}名 / 未突合 ${unmatched.size}`);
  if (unmatched.size) console.log("  未突合:", [...unmatched].slice(0, 10));
  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で投入 (対象月既存を先に削除)。"); return; }

  const ids = [...new Set(Object.values(map))];
  let del = 0;
  for (let i = 0; i < ids.length; i += 200) { const { count } = await sb.from("kaigo_benefit_management").delete({ count: "exact" }).eq("billing_month", BILLING_MONTH).in("user_id", ids.slice(i, i + 200)); del += count || 0; }
  let ins = 0, dropShiteiKubun = false;
  for (let i = 0; i < rows.length; i += 200) {
    let chunk = rows.slice(i, i + 200);
    if (dropShiteiKubun) chunk = chunk.map(({ shitei_kubun, ...rest }) => rest);
    let { error } = await sb.from("kaigo_benefit_management").insert(chunk);
    // shitei_kubun 列未適用 (kyufu_kanri_shitei_kubun.sql) の環境では列なしで再試行
    if (error && !dropShiteiKubun && /shitei_kubun/.test(error.message)) {
      console.warn("⚠ shitei_kubun 列が未適用のため区分なしで投入 (kyufu_kanri_shitei_kubun.sql 適用後に再実行推奨)");
      dropShiteiKubun = true;
      ({ error } = await sb.from("kaigo_benefit_management").insert(chunk.map(({ shitei_kubun, ...rest }) => rest)));
    }
    if (error) { console.error("挿入失敗:", error.message); process.exit(1); }
    ins += chunk.length;
  }
  console.log(`既存削除 ${del} / 挿入 ${ins} 完了${dropShiteiKubun ? " (shitei_kubun なし)" : ""}`);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
