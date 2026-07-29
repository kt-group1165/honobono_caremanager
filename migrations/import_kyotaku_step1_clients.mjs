// ============================================================================
// 居宅介護支援 STEP1: 大網居宅の管理利用者 → clients / client_insurance_records /
//   client_office_assignments (居宅office)。
//   キー = 利用者番号 (基本情報CSV=共有マスタ 376名 と一致)。
//   源:
//     - 居宅請求明細: サービス実績データ/大網/居宅/202606/202606/大網2026_06.CSV
//       (利用者番号・被保番・保険者・要介護度・認定期間)
//     - 基本情報: 利用者データ/大網/基本情報_______.CSV (氏名・生年・性別・住所・電話。共有マスタ)
//   既存clientは user_number(利用者番号) 一致で再利用。無ければ 基本情報 から新規作成。
//
//   node migrations/import_kyotaku_step1_clients.mjs            # DRY RUN
//   node migrations/import_kyotaku_step1_clients.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const TENANT = "kt-group";
const OFFICE_ID = "755e64de-1289-473f-9423-150a9a9268d4"; // リンクス居宅介護支援事業所大網白里
const MARK = "[居宅STEP1 2026-06 大網]";
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const CSV_KYOTAKU = path.join(KAIGO, "サービス実績データ/大網/居宅/202606/202606/大網2026_06.CSV");
const CSV_BASE = path.join(KAIGO, "利用者データ/大網/基本情報_______.CSV");
function loadEnv() { const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8"); const e = {}; for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, ""); } return e; }
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sjis = new TextDecoder("shift_jis");
function pl(l){const o=[];let c="",q=false;for(let i=0;i<l.length;i++){const ch=l[i];if(q){if(ch==='"'){if(l[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}else{if(ch==='"')q=true;else if(ch===","){o.push(c);c="";}else c+=ch;}}o.push(c);return o;}
const careNorm = (s) => (s || "").normalize("NFKC").replace(/\s/g, "");
const iso = (s) => { const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((s || "").trim()); return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null; };
const genderNorm = (s) => (s || "").includes("女") ? "女" : (s || "").includes("男") ? "男" : null;
const num = (s) => (s || "").trim();

async function main() {
  console.log(`=== 居宅STEP1 (大網・利用者番号キー) ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  // 基本情報 (共有マスタ) を 利用者番号 → demographics。ただし利用者番号が複数人共有
  //   (2147483647等ゴミ番号) の場合は demographics 不確実なので使わない。
  const bl = sjis.decode(readFileSync(CSV_BASE)).split(/\r?\n/).filter((l) => l);
  const Hb = pl(bl[0]); const gb = (n) => Hb.indexOf(n);
  const baseByNum = new Map(); const baseCount = new Map();
  for (const l of bl.slice(1)) {
    const c = pl(l); const u = num(c[gb("利用者番号")]); if (!u) continue;
    baseCount.set(u, (baseCount.get(u) || 0) + 1);
    if (!baseByNum.has(u)) baseByNum.set(u, {
      furigana: (c[gb("フリガナ")] || "").trim(),
      postal: (c[gb("郵便番号")] || "").trim(), address: (c[gb("住所")] || "").trim(),
      phone: (c[gb("電話番号")] || "").trim(), mobile: (c[gb("携帯番号")] || "").trim(),
    });
  }

  // 居宅請求明細 を 被保番(=一意) → 全属性。名前/性別/生年は居宅請求CSVに有る。
  const kl = sjis.decode(readFileSync(CSV_KYOTAKU)).split(/\r?\n/).filter((l) => l);
  const Hk = pl(kl[0]); const gk = (n) => Hk.indexOf(n);
  const iKIns = gk("被保険者番号"), iKUser = gk("利用者番号"), iKNm = gk("被保険者名"), iKSex = gk("性別"),
    iKHoken = gk("保険者番号"), iKCare = gk("要介護度"), iKCs = gk("認定期間（開始）"), iKCe = gk("認定期間（終了）"), iKBirth = gk("生年月日");
  const numShared = new Set(); // 複数被保番が共有する利用者番号
  { const seen = new Map(); for (const l of kl.slice(1)) { const c = pl(l); const u = num(c[iKUser]), ins = num(c[iKIns]); if (!u || !ins) continue; if (!seen.has(u)) seen.set(u, new Set()); seen.get(u).add(ins); } for (const [u, s] of seen) if (s.size > 1) numShared.add(u); }

  const kyotaku = new Map(); // 被保番 → client info
  for (const l of kl.slice(1)) {
    const c = pl(l); const ins = num(c[iKIns]); if (!ins) continue;
    if (!kyotaku.has(ins)) kyotaku.set(ins, {
      insured: ins, userNo: num(c[iKUser]), name: (c[iKNm] || "").trim(), gender: genderNorm(c[iKSex]),
      birth: iso(c[iKBirth]), insurer: num(c[iKHoken]), care: careNorm(c[iKCare]),
      certStart: iso(c[iKCs]), certEnd: iso(c[iKCe]),
    });
  }
  console.log(`居宅管理利用者 (被保番unique): ${kyotaku.size}名 / 共有利用者番号(ゴミ): ${[...numShared].join(",")}`);

  // 既存clients (被保番→ / user_number→)
  // 既存突合キー = 被保番 + 保険者番号。被保番だけだと保険者をまたいで別人が同番号を
  //   共有し (例: 白子町0000023747 吉原芳夫 ≠ 睦沢町0000023747 中村光一)、別人紐付け事故になる。
  const byIns = new Map(), byNum = new Map();
  for (let f = 0; ; f += 1000) { const { data, error } = await sb.from("clients").select("id,user_number,name,insured_number,insurer_number").range(f, f + 999); if (error) throw error; for (const c of data) { if (c.insured_number) byIns.set(`${c.insured_number}|${c.insurer_number || ""}`, c); byNum.set(String(c.user_number), c); } if (data.length < 1000) break; }

  const reuse = [], toCreate = [];
  for (const k of kyotaku.values()) {
    const ex = byIns.get(`${k.insured}|${k.insurer}`); // 被保番+保険者番号で既存突合 (別人衝突を回避)
    if (ex) { reuse.push({ ...k, id: ex.id }); continue; }
    // user_number: 利用者番号 (共有ゴミ番号は被保番でリナンバー / 既に使われていてもリナンバー)
    let un = k.userNo;
    if (numShared.has(k.userNo) || byNum.has(k.userNo)) un = `${k.userNo}-${k.insured}`;
    // 住所等は利用者番号がユニークな時のみ基本情報から
    const b = (!numShared.has(k.userNo) && baseCount.get(k.userNo) === 1) ? baseByNum.get(k.userNo) : null;
    toCreate.push({ ...k, userNumber: un, ...(b || {}) });
  }
  const careDist = {}; for (const k of kyotaku.values()) careDist[k.care] = (careDist[k.care] || 0) + 1;
  console.log(`  既存再利用(被保番一致): ${reuse.length}名 / 新規作成: ${toCreate.length}名`);
  console.log(`  要介護度: ${JSON.stringify(careDist)}`);
  const renum = toCreate.filter((k) => k.userNumber !== k.userNo);
  if (renum.length) console.log(`  リナンバー(ゴミ番号衝突): ${renum.map((k) => k.name + "→" + k.userNumber).join(", ")}`);
  if (toCreate[0]) console.log(`\n新規サンプル: ${JSON.stringify({ un: toCreate[0].userNumber, name: toCreate[0].name, care: toCreate[0].care, birth: toCreate[0].birth, addr: (toCreate[0].address || "").slice(0, 12) })}`);

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で clients作成 + insurance + assignment(全員居宅office)。"); return; }

  const mapping = {}; let created = 0; // 被保番 → client_id
  for (const k of toCreate) {
    const { data: cli, error: e1 } = await sb.from("clients").insert({
      user_number: k.userNumber, name: k.name || `(氏名不明 ${k.insured})`, furigana: k.furigana || null,
      tenant_id: TENANT, status: "active", is_provisional: false,
      gender: k.gender, birth_date: k.birth, postal_code: k.postal || null, address: k.address || null,
      phone: k.phone || null, mobile: k.mobile || null,
      insured_number: k.insured, insurer_number: k.insurer,
      care_level: k.care, certification_start_date: k.certStart, certification_end_date: k.certEnd,
    }).select("id").single();
    if (e1) { console.error(`✗ client ${k.insured}: ${e1.message}`); process.exit(1); }
    mapping[k.insured] = cli.id; created++;
    const { error: e2 } = await sb.from("client_insurance_records").insert({
      tenant_id: TENANT, client_id: cli.id, insured_number: k.insured, insurer_number: k.insurer,
      care_level: k.care, certification_status: "認定済み", certification_start_date: k.certStart, certification_end_date: k.certEnd,
      copay_rate: "1", notes: MARK,
    });
    if (e2) console.error(`✗ insurance ${k.insured}: ${e2.message}`);
  }
  for (const k of reuse) mapping[k.insured] = k.id;

  const cids = [...new Set(Object.values(mapping))]; let assigned = 0;
  for (const cid of cids) {
    const { data: ex } = await sb.from("client_office_assignments").select("id").eq("client_id", cid).eq("office_id", OFFICE_ID).maybeSingle();
    if (ex) continue;
    const { error } = await sb.from("client_office_assignments").insert({ client_id: cid, office_id: OFFICE_ID, tenant_id: TENANT });
    if (!error) assigned++;
  }
  writeFileSync(path.join(KAIGO, "migrations/_kyotaku_num_to_client_大網.json"), JSON.stringify(mapping));
  console.log(`✓ 完了: 新規${created}名 / 既存再利用${reuse.length}名 / assignment新規${assigned}件 → _kyotaku_num_to_client_大網.json`);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
