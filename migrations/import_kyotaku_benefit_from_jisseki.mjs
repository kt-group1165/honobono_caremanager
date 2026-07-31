// 給付管理データを「事業所別請求額」(実績の明細レポート) から**独立生成**する。
//
//   ⚠ 従来の import_kyotaku_benefit_from_ky.mjs は KY伝送を正本にしていたが、
//     伝送を取込元にすると同じ伝送と突き合わせても循環で検証にならない。
//     こちらは伝送を一切使わず実績から組み立てるので、KY との照合が
//     「数字そのものの検証」になる。
//
//   集計単位 = 提供事業所番号 × サービス種類コード ごとの Σ(サービス単位／金額)
//   除外ルール (KY照合で確立):
//     - 「支給限度額対象外」(処遇改善・提供体制加算等) は区分支給限度基準内でないため除外
//     - 同一(被保|保険|提供|種類|サービスコード)で「明細」と「明細・小計」が併存する場合は
//       小計側が重複なので除外 (長期併設短期入所)。小計が単独ならそれを採用
//     - 合計0単位のグループは除外 (回数0の未実施予定)
//
//   限度額超過時、ケアマネが特定サービスを減単位して合計を限度額に収めることがある。
//   その調整は実績CSVには存在せず KY にしかないため、そこだけは一致しない (想定内)。
//   --compare で KY と突合し「完全一致N名 / 調整あり M名」を出す。
//
//   OFFICE_BN=<事業所番号> OFFICE_ID=<uuid> TAG=<略称> [KY=<KYパス>] \
//     node migrations/import_kyotaku_benefit_from_jisseki.mjs [--execute] [--compare]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const COMPARE = process.argv.includes("--compare");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const OFFICE_BN = process.env.OFFICE_BN, OFFICE_ID = process.env.OFFICE_ID, TAG = process.env.TAG;
const KY = process.env.KY;
if (!OFFICE_BN || !OFFICE_ID || !TAG) { console.error("OFFICE_BN / OFFICE_ID / TAG が必要"); process.exit(1); }
const BILLING_MONTH = "2026-06", YM = "202606";
const CSV = path.join(KAIGO, "サービス実績データ/全居宅/202606/全居宅事業所別請求額.CSV");

function loadEnv() { const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8"); const e = {}; for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, ""); } return e; }
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sjis = new TextDecoder("shift_jis");
function pl(l){const o=[];let c="",q=false;for(let i=0;i<l.length;i++){const ch=l[i];if(q){if(ch==='"'){if(l[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}else{if(ch==='"')q=true;else if(ch===","){o.push(c);c="";}else c+=ch;}}o.push(c);return o;}
const padIns = (s) => (s || "").trim().replace(/\s/g, "").padStart(10, "0");
const padInsurer = (s) => (s || "").trim().replace(/\s/g, "").padStart(6, "0");
const num = (s) => Number(String(s || "").replace(/[^\d.-]/g, "")) || 0;

async function main() {
  console.log(`=== 給付管理 独立生成 (実績起点) (${TAG}) ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const rows = sjis.decode(readFileSync(CSV)).split(/\r?\n/).filter((l) => l).map(pl);
  const H = rows[0]; const g = (n) => H.indexOf(n);
  const iSup = g("事業所番号（支援事業所）"), iProv = g("事業所番号（提供事業所）"),
    iKind = g("サービス種類コード（提供事業所）"), iProvName = g("事業所名（提供事業所）"),
    iKindName = g("事業種別名（提供事業所）"), iCode = g("サービスコード"), iUnits = g("サービス単位／金額"),
    iCnt = g("回数"), iIns = g("被保険者番号"), iHoken = g("保険者番号"), iKubun = g("サービス区分");
  if ([iSup, iProv, iKind, iUnits, iIns, iHoken, iKubun].some((i) => i < 0)) { console.error("ヘッダー不一致"); process.exit(1); }

  const mine = rows.slice(1).filter((r) => (r[iSup] || "").trim() === OFFICE_BN);
  console.log(`実績CSV 当事業所の明細行: ${mine.length}`);

  // 「明細・小計」の重複除外: 同一(被保|保険|提供|種類|サービスコード) に「明細」があれば小計を捨てる
  const hasMeisai = new Set();
  for (const r of mine) {
    if ((r[iKubun] || "").trim() !== "明細") continue;
    hasMeisai.add([padIns(r[iIns]), padInsurer(r[iHoken]), (r[iProv] || "").trim(), (r[iKind] || "").trim(), (r[iCode] || "").trim()].join("|"));
  }

  const agg = new Map(); // 被保|保険|提供|種類 → { units, provName, kindName }
  let skipGentaigai = 0, skipShoukei = 0;
  for (const r of mine) {
    const kubun = (r[iKubun] || "").trim();
    if (kubun === "支給限度額対象外") { skipGentaigai++; continue; }
    const detailKey = [padIns(r[iIns]), padInsurer(r[iHoken]), (r[iProv] || "").trim(), (r[iKind] || "").trim(), (r[iCode] || "").trim()].join("|");
    if (kubun === "明細・小計" && hasMeisai.has(detailKey)) { skipShoukei++; continue; }
    const k = [padIns(r[iIns]), padInsurer(r[iHoken]), (r[iProv] || "").trim(), (r[iKind] || "").trim()].join("|");
    if (!agg.has(k)) agg.set(k, { units: 0, provName: (r[iProvName] || "").trim(), kindName: (r[iKindName] || "").trim(), cnt: 0 });
    const e = agg.get(k);
    e.units += num(r[iUnits]);
    e.cnt += num(r[iCnt]);
  }
  // 0単位グループは除外 (未実施予定)
  let skipZero = 0;
  for (const [k, v] of [...agg]) if (v.units <= 0) { agg.delete(k); skipZero++; }
  console.log(`除外: 支給限度額対象外 ${skipGentaigai} / 明細・小計の重複 ${skipShoukei} / 0単位 ${skipZero}`);
  console.log(`生成した給付管理明細: ${agg.size} 行 / ${new Set([...agg.keys()].map((k) => k.split("|").slice(0, 2).join("|"))).size} 名`);

  // ── KY と突合 (--compare) ──
  if (COMPARE && KY) {
    const ky = sjis.decode(readFileSync(path.isAbsolute(KY) ? KY : path.join(KAIGO, KY))).split(/\r?\n/).filter((l) => l).map(pl)
      .filter((r) => r[2] === "8222" && r[3] === YM && r[9] !== "99");
    const kyAgg = new Map();
    for (const r of ky) {
      const k = [padIns(r[10]), padInsurer(r[4].replace(/^0+/, "")), (r[18] || "").trim(), (r[20] || "").trim()].join("|");
      kyAgg.set(k, (kyAgg.get(k) || 0) + num(r[21]));
    }
    const users = new Set([...agg.keys(), ...kyAgg.keys()].map((k) => k.split("|").slice(0, 2).join("|")));
    let same = 0; const diffUsers = [];
    for (const u of users) {
      const mineLines = [...agg].filter(([k]) => k.startsWith(u + "|"));
      const kyLines = [...kyAgg].filter(([k]) => k.startsWith(u + "|"));
      const keys = new Set([...mineLines.map(([k]) => k), ...kyLines.map(([k]) => k)]);
      let ok = true;
      for (const k of keys) if ((agg.get(k)?.units ?? 0) !== (kyAgg.get(k) ?? 0)) ok = false;
      if (ok) same++;
      else diffUsers.push({ u, mine: mineLines.reduce((s, [, v]) => s + v.units, 0), ky: kyLines.reduce((s, [, v]) => s + v, 0) });
    }
    console.log(`\n── KY照合 ── 完全一致 ${same}名 / 差あり ${diffUsers.length}名 (= ケアマネの限度額調整等)`);
    for (const d of diffUsers.slice(0, 12)) console.log(`   ${d.u}  実績${d.mine} → KY${d.ky} (差 ${d.ky - d.mine})`);
    if (diffUsers.length > 12) console.log(`   …他 ${diffUsers.length - 12}名`);
  }

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で投入 (対象月の当事業所分を入替)。"); return; }

  const map = JSON.parse(readFileSync(path.join(KAIGO, `migrations/_kyotaku_office_map_${TAG}.json`), "utf8"));
  const out = []; const unmatched = new Set();
  for (const [k, v] of agg) {
    const [ins, insurer, prov, kind] = k.split("|");
    const cid = map[`${ins}|${insurer}`];
    if (!cid) { unmatched.add(`${ins}|${insurer}`); continue; }
    out.push({ user_id: cid, billing_month: BILLING_MONTH, service_type: v.kindName || "", service_kind_code: kind,
      provider_name: v.provName || "", provider_number: prov, planned_units: v.units, actual_units: v.units,
      over_limit_units: 0, status: "draft", tenant_id: "kt-group" });
  }
  console.log(`\n突合 ${out.length}行 / ${new Set(out.map((r) => r.user_id)).size}名 / 未突合 ${unmatched.size}`);
  if (unmatched.size) console.log("  未突合:", [...unmatched].slice(0, 8));

  const ids = [...new Set(Object.values(map))];
  let del = 0;
  for (let i = 0; i < ids.length; i += 200) { const { count } = await sb.from("kaigo_benefit_management").delete({ count: "exact" }).eq("billing_month", BILLING_MONTH).in("user_id", ids.slice(i, i + 200)); del += count || 0; }
  let ins2 = 0;
  for (let i = 0; i < out.length; i += 200) { const { error } = await sb.from("kaigo_benefit_management").insert(out.slice(i, i + 200)); if (error) { console.error("挿入失敗:", error.message); process.exit(1); } ins2 += out.slice(i, i + 200).length; }
  console.log(`既存削除 ${del} / 挿入 ${ins2} 完了`);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
