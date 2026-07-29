// 大網居宅: 事業所別請求額.CSV → kaigo_benefit_management (給付管理票 8221 の元データ)。
//   給付管理単位 = 提供事業所×サービス種類ごとの Σ(サービス単位数×回数)。
//   「支給限度額対象外」行は区分支給限度基準内でないため除外。
//   利用者突合キー = 被保番 + 保険者番号 (居宅STEP1と同じ。別人衝突回避)。
//   node migrations/import_kyotaku_benefit_management.mjs [--execute]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const OFFICE_ID = "755e64de-1289-473f-9423-150a9a9268d4"; // リンクス居宅介護支援大網白里
const SUPPORT_NO = "1279200081"; // 支援事業所番号 (col5) フィルタ
const BILLING_MONTH = "2026-06";
const CSV = "サービス実績データ/大網/居宅/202606/202606/事業所別請求額.CSV";

function loadEnv() { const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8"); const e = {}; for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, ""); } return e; }
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sjis = new TextDecoder("shift_jis");
function pl(l){const o=[];let c="",q=false;for(let i=0;i<l.length;i++){const ch=l[i];if(q){if(ch==='"'){if(l[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}else{if(ch==='"')q=true;else if(ch===","){o.push(c);c="";}else c+=ch;}}o.push(c);return o;}
const padIns = (s) => (s || "").trim().replace(/\s/g, "").padStart(10, "0");
const padInsurer = (s) => (s || "").trim().replace(/\s/g, "").padStart(6, "0");
const key = (ins, insurer) => `${padIns(ins)}|${padInsurer(insurer)}`;

async function main() {
  console.log(`=== 給付管理データ取込 (大網居宅 ${BILLING_MONTH}) ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  // 1) CSV 集計: (被保番|保険者, 提供番号, 種類コード) → { units, providerName, serviceType }
  const lines = sjis.decode(readFileSync(path.join(KAIGO, CSV))).split(/\r?\n/).filter((l) => l);
  const H = pl(lines[0]); const gi = (n) => H.indexOf(n);
  const iSup = gi("事業所番号（支援事業所）"), iKind = gi("サービス種類コード（提供事業所）"),
    iKindName = gi("事業種別名（提供事業所）"), iProvNo = gi("事業所番号（提供事業所）"),
    iProvName = gi("事業所名（提供事業所）"), iUnitTotal = gi("サービス単位／金額"),
    iIns = gi("被保険者番号"), iInsurer = gi("保険者番号"), iKubun = gi("サービス区分");

  const iCode = gi("サービスコード");
  const own = (c) => (c[iSup] || "").trim() === SUPPORT_NO;
  const isOver = (c) => (c[iKubun] || "").trim() === "支給限度額対象外";
  // 同一(被保|保険|提供|種類|サービスコード)で「明細」が存在するコード集合。
  //   ほのぼのは 長期併設短期入所等で「明細・小計」行(重複)を給付管理票に載せず
  //   「明細」行のみ採用する (KY260701 実測: 鈴木美枝 715×1 を除外) → 併存時は小計側を捨てる。
  const hasMeisai = new Set();
  for (const l of lines.slice(1)) { const c = pl(l); if (!own(c) || isOver(c)) continue; if ((c[iKubun] || "").trim() === "明細") hasMeisai.add(`${c[iIns]}|${c[iInsurer]}|${c[iProvNo]}|${c[iKind]}|${c[iCode]}`); }

  const agg = new Map(); // ukey|prov|kind -> {units, providerName, serviceType, ins, insurer}
  let skippedOver = 0, skippedDupSubtotal = 0;
  for (const l of lines.slice(1)) {
    const c = pl(l);
    if (!own(c)) continue;
    if (isOver(c)) { skippedOver++; continue; } // 区分限度外は給付管理対象外
    // 「明細・小計」だが同一コードに「明細」も併存 → 小計側の重複計上を除外
    if ((c[iKubun] || "").trim() === "明細・小計" && hasMeisai.has(`${c[iIns]}|${c[iInsurer]}|${c[iProvNo]}|${c[iKind]}|${c[iCode]}`)) { skippedDupSubtotal++; continue; }
    const ins = c[iIns], insurer = c[iInsurer];
    const prov = (c[iProvNo] || "").trim();
    const kind = (c[iKind] || "").trim();
    const units = Number(c[iUnitTotal] || 0) || 0;
    const k = `${key(ins, insurer)}|${prov}|${kind}`;
    if (!agg.has(k)) agg.set(k, { units: 0, providerName: (c[iProvName] || "").trim(), serviceType: (c[iKindName] || "").trim(), ins: padIns(ins), insurer: padInsurer(insurer), prov, kind });
    agg.get(k).units += units;
  }
  // 0単位グループ (回数0の未実施予定) はほのぼのも給付管理票に載せない → 除外
  let skippedZero = 0;
  for (const [k, v] of [...agg]) { if (v.units === 0) { agg.delete(k); skippedZero++; } }
  console.log(`CSV: 集計行 ${agg.size} / 対象外スキップ ${skippedOver} / 小計重複除外 ${skippedDupSubtotal} / 0単位除外 ${skippedZero}`);

  // 2) 大網居宅の 139 名を DB から取得し 被保番|保険者 → user_id
  const { data: assigns, error: ae } = await sb.from("client_office_assignments").select("client_id").eq("office_id", OFFICE_ID);
  if (ae) throw new Error(ae.message);
  const ids = assigns.map((a) => a.client_id);
  const byKey = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const { data: cs, error: ce } = await sb.from("clients").select("id, name, insured_number, insurer_number").in("id", ids.slice(i, i + 200));
    if (ce) throw new Error(ce.message);
    for (const c of cs) byKey.set(key(c.insured_number, c.insurer_number), { id: c.id, name: c.name });
  }
  console.log(`DB: 大網居宅 clients ${ids.length} 名 (突合キー ${byKey.size})`);

  // 3) 集計を利用者ごとに束ね、user_id 解決
  const rows = [];
  const unmatched = new Map();
  for (const [, v] of agg) {
    const ukey = `${v.ins}|${v.insurer}`;
    const cli = byKey.get(ukey);
    if (!cli) { unmatched.set(ukey, v); continue; }
    rows.push({
      user_id: cli.id,
      billing_month: BILLING_MONTH,
      service_type: v.serviceType,
      service_kind_code: v.kind,
      provider_name: v.providerName,
      provider_number: v.prov,
      planned_units: v.units,
      actual_units: v.units,
      over_limit_units: 0,
      status: "draft",
      tenant_id: "kt-group",
    });
  }
  const matchedUsers = new Set(rows.map((r) => r.user_id));
  console.log(`\n突合済: ${rows.length} 行 / ${matchedUsers.size} 名`);
  if (unmatched.size) {
    console.log(`⚠ 未突合 (被保番|保険者): ${unmatched.size} 名`);
    for (const [k, v] of unmatched) console.log(`   ${k}  ${v.serviceType}(${v.prov}) ${v.units}単位`);
  }

  if (!EXECUTE) {
    console.log("\n※ DRY RUN。--execute で kaigo_benefit_management に投入 (対象月既存を先に削除)。");
    console.log("先頭3行サンプル:", rows.slice(0, 3));
    return;
  }

  // 4) 対象月×139名の既存を削除 → 挿入 (再取込を冪等に)
  let del = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const { error: de, count } = await sb.from("kaigo_benefit_management").delete({ count: "exact" }).eq("billing_month", BILLING_MONTH).in("user_id", ids.slice(i, i + 200));
    if (de) throw new Error(`削除失敗: ${de.message}`);
    del += count || 0;
  }
  console.log(`既存削除: ${del} 行`);
  let ins = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const { error: ie } = await sb.from("kaigo_benefit_management").insert(rows.slice(i, i + 200));
    if (ie) { console.error(`挿入失敗:`, ie.message); if (/service_kind_code|provider_number/.test(ie.message)) console.error("→ 先に migration (kyufu_kanri_provider_number.sql) を適用してください"); process.exit(1); }
    ins += rows.slice(i, i + 200).length;
  }
  console.log(`挿入: ${ins} 行 完了`);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
