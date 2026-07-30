// ============================================================================
// 居宅介護支援 STEP1 (全事業所汎用): 全居宅マスタ + 居宅サービス計 から
//   clients / client_insurance_records(限度額込) / client_office_assignments /
//   kaigo_care_plans(active・届出日・ケアマネ番号) を一括作成。
//   → この後アプリ「一括生成」で居宅介護支援費レセプトが作れる状態になる。
//
//   源 (全居宅・全事業所共通):
//     - 居宅サービス計: サービス実績データ/全居宅/202606/全居宅居宅サービス計.CSV
//        (居宅介護支援事業所番号でフィルタ。被保番/保険者/利用者番号/要介護度/認定期間/
//         生年月日/届出日/ケアマネ番号)
//     - 限度額: 利用者データ/全居宅/介護保険 全居宅.CSV (区分支給限度基準額・給付率)
//     - 氏名等: 利用者データ/全居宅/基本情報全居宅.CSV (利用者番号キー)
//   突合キー = 被保番 + 保険者番号 (別人衝突回避)。既存clientは再利用。
//
//   OFFICE_BN=<事業所番号> OFFICE_ID=<uuid> TAG=<略称> \
//     node migrations/import_kyotaku_office.mjs [--execute]
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const TENANT = "kt-group";
const OFFICE_BN = process.env.OFFICE_BN;
const OFFICE_ID = process.env.OFFICE_ID;
const TAG = process.env.TAG || OFFICE_BN;
if (!OFFICE_BN || !OFFICE_ID) { console.error("OFFICE_BN と OFFICE_ID が必要です"); process.exit(1); }
const MARK = `[居宅STEP1 2026-06 ${TAG}]`;
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const CSV_KEI = path.join(KAIGO, "サービス実績データ/全居宅/202606/全居宅居宅サービス計.CSV");
const CSV_HOKEN = path.join(KAIGO, "利用者データ/全居宅/介護保険 全居宅.CSV");
const CSV_BASE = path.join(KAIGO, "利用者データ/全居宅/基本情報全居宅.CSV");
const CSV_KOHI = path.join(KAIGO, "利用者データ/全居宅/公費全居宅.CSV");
const MONTH_START = "2026-06-01", MONTH_END = "2026-06-30";

function loadEnv() { const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8"); const e = {}; for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, ""); } return e; }
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sjis = new TextDecoder("shift_jis");
function pl(l){const o=[];let c="",q=false;for(let i=0;i<l.length;i++){const ch=l[i];if(q){if(ch==='"'){if(l[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}else{if(ch==='"')q=true;else if(ch===","){o.push(c);c="";}else c+=ch;}}o.push(c);return o;}
const careNorm = (s) => (s || "").normalize("NFKC").replace(/\s/g, "");
const iso = (s) => { const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((s || "").trim()); return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null; };
const genderNorm = (s) => (s || "").includes("女") ? "女" : (s || "").includes("男") ? "男" : null;
// 氏名の突合キー (全角/半角スペース差を吸収)
const nameKey = (s) => (s || "").normalize("NFKC").replace(/\s/g, "");
const num = (s) => (s || "").trim();
const rd = (p) => sjis.decode(readFileSync(p)).split(/\r?\n/).filter((l) => l).map(pl);
const copayFromRate = (r) => { const n = Number((r || "").replace(/[^\d]/g, "")); return n === 80 ? "2" : n === 70 ? "3" : "1"; };

async function main() {
  console.log(`=== 居宅STEP1 汎用 (${TAG} / ${OFFICE_BN}) ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  // 1) 居宅サービス計 を事業所でフィルタ → 被保番|保険者 unique の利用者属性
  const kei = rd(CSV_KEI); const Hk = kei[0]; const gk = (n) => Hk.indexOf(n);
  const iOff = gk("居宅介護支援事業所番号"), iIns = gk("被保険者番号"), iHoken = gk("保険者番号"),
    iUser = gk("利用者番号"), iCare = gk("要介護度"), iCs = gk("認定期間（開始）"), iCe = gk("認定期間（終了）"),
    iBirth = gk("生年月日"), iTodoke = gk("届出日"), iCM = gk("居宅介護支援専門員番号");
  const users = new Map(); // 被保番|保険者 → info
  for (const c of kei.slice(1)) {
    if (num(c[iOff]) !== OFFICE_BN) continue;
    const ins = num(c[iIns]), hoken = num(c[iHoken]); if (!ins || !hoken) continue;
    const key = `${ins}|${hoken}`;
    if (!users.has(key)) users.set(key, {
      insured: ins, insurer: hoken, userNo: num(c[iUser]), care: careNorm(c[iCare]),
      certStart: iso(c[iCs]), certEnd: iso(c[iCe]), birth: iso(c[iBirth]),
      requestDate: iso(c[iTodoke]), careMgr: num(c[iCM]),
    });
  }
  console.log(`サービス計 ${TAG} 利用者(被保番+保険者): ${users.size}名`);

  // 2) 介護保険全居宅 → 限度額 + 給付率(copay) + 氏名/性別 (被保番|保険者、対象月有効・認定済み優先)
  const hoken = rd(CSV_HOKEN); const Hh = hoken[0]; const gh = (n) => Hh.indexOf(n);
  const hIns = gh("被保険者番号"), hHoken = gh("保険者番号"), hLimit = gh("区分支給限度基準額（居宅ｻｰﾋﾞｽ区分）"),
    hRate = gh("給付率"), hName = gh("利用者名"), hCs = gh("認定有効期間－開始日"), hCe = gh("認定有効期間－終了日"),
    hLs = gh("適用期間－開始日（居宅ｻｰﾋﾞｽ区分）"), hLe = gh("適用期間－終了日（居宅ｻｰﾋﾞｽ区分）");
  const hokenByKey = new Map();
  for (const c of hoken.slice(1)) {
    const key = `${num(c[hIns])}|${num(c[hHoken])}`;
    const cs = iso(c[hCs]), ce = iso(c[hCe]);
    const covers = cs && ce && cs <= MONTH_END && ce >= MONTH_START;
    const cur = hokenByKey.get(key);
    // 限度額適用期間 (8222 項13/14)。区分変更等で認定有効期間と異なることがある → 別列で保持
    const rec = { limit: Number((c[hLimit] || "").replace(/[^\d]/g, "")) || 0, copay: copayFromRate(c[hRate]), name: (c[hName] || "").trim(),
      limitStart: iso(c[hLs]), limitEnd: iso(c[hLe]),
      // マスタ側の認定終了。サービス計 (対象月の実績データ) と一致しなければ
      // 「対象月の請求後にマスタが更新された」と判断する材料になる
      mCertEnd: ce, covers };
    if (!cur || (covers && !cur.covers)) hokenByKey.set(key, rec);
  }

  // 3) 基本情報全居宅 → demographics。利用者番号キー(ユニーク時) と
  //    利用者番号+生年月日キー の両方を作る。利用者番号が複数人共有(リナンバー)でも
  //    生年月日で曖昧性を解消して性別/住所を拾える (今川滿=利35共有 でも 生年月日で特定)。
  const base = rd(CSV_BASE); const Hb = base[0]; const gb = (n) => Hb.indexOf(n);
  const baseByNum = new Map(), baseCount = new Map(), baseByNumBirth = new Map(), baseByNameBirth = new Map();
  for (const c of base.slice(1)) {
    const rec = {
      name: (c[gb("利用者名")] || "").trim(), furigana: (c[gb("フリガナ")] || "").trim(),
      gender: genderNorm(c[gb("性別")]), birth: iso(c[gb("生年月日")]),
      postal: (c[gb("郵便番号")] || "").trim(), address: (c[gb("住所")] || "").trim(),
      phone: (c[gb("電話番号")] || "").trim(), mobile: (c[gb("携帯番号")] || "").trim(),
    };
    // 氏名+生年月日 索引。**利用者番号が空の行も拾う** (ほのぼの実データに番号空が存在し、
    // 番号キーだけだと性別等が欠落する。袖ヶ浦「小嶋 つる」で 8222 項11 が空になった)
    if (rec.name && rec.birth) {
      const nk = `${nameKey(rec.name)}|${rec.birth}`;
      if (!baseByNameBirth.has(nk)) baseByNameBirth.set(nk, rec);
    }
    const u = num(c[gb("利用者番号")]); if (!u) continue;
    baseCount.set(u, (baseCount.get(u) || 0) + 1);
    if (!baseByNum.has(u)) baseByNum.set(u, rec);
    if (rec.birth) baseByNumBirth.set(`${u}|${rec.birth}`, rec);
  }

  // 4) 既存clients (被保番+保険者 / 利用者番号)
  const byIns = new Map(), byNum = new Map();
  // ⚠ order 無しの range ページングは行の取りこぼし/重複が起きる (PostgREST/Postgres は
  //   ORDER BY が無いと順序を保証しない)。実行ごとに別 client にマッチして重複割当が
  //   できた実例あり (姉ム 角文枝)。必ず order を付ける。
  //   さらに同一被保番の client が複数ある場合は **古い方を優先** して安定させる。
  for (let f = 0; ; f += 1000) { const { data, error } = await sb.from("clients").select("id,user_number,insured_number,insurer_number,created_at").order("created_at", { ascending: true }).order("id", { ascending: true }).range(f, f + 999); if (error) throw error; for (const c of data) { if (c.insured_number) { const k = `${c.insured_number}|${c.insurer_number || ""}`; if (!byIns.has(k)) byIns.set(k, c); } if (!byNum.has(String(c.user_number))) byNum.set(String(c.user_number), c); } if (data.length < 1000) break; }

  // 利用者番号が複数被保番で共有 (ゴミ番号) 検出
  const numShared = new Set();
  { const seen = new Map(); for (const [, u] of users) { if (!seen.has(u.userNo)) seen.set(u.userNo, new Set()); seen.get(u.userNo).add(u.insured); } for (const [n, s] of seen) if (s.size > 1) numShared.add(n); }

  const reuse = [], toCreate = [];
  for (const [key, u] of users) {
    const h = hokenByKey.get(key) || {};
    // demographics: ①利用者番号+生年月日 (共有番号でも安全) ②番号ユニーク時のみ番号
    // ③氏名(介護保険CSV由来)+生年月日 ← 利用者番号が空の利用者の救済
    const b = (u.birth && baseByNumBirth.get(`${u.userNo}|${u.birth}`))
      || ((!numShared.has(u.userNo) && baseCount.get(u.userNo) === 1) ? baseByNum.get(u.userNo) : null)
      || ((u.birth && h.name) ? baseByNameBirth.get(`${nameKey(h.name)}|${u.birth}`) : null);
    const rec = { ...u, name: (b?.name) || h.name || `(氏名不明 ${u.insured})`, furigana: b?.furigana || null,
      gender: u.gender || b?.gender || null, birth: u.birth || b?.birth || null,
      postal: b?.postal || null, address: b?.address || null, phone: b?.phone || null, mobile: b?.mobile || null,
      limit: h.limit || 0, copay: h.copay || "1",
      // 限度額適用期間 (8222 項13/14) はマスタCSVの「適用期間（居宅ｻｰﾋﾞｽ区分）」を初期値に。
      //   認定期間とは別物で、認定より短い場合 (区分変更) も長い場合 (K姉 1000042631:
      //   認定2026/10/31 に対し適用2028/10/31) もある。
      //   ただしマスタは出力時点のスナップショットで、対象月の請求後に認定更新が入ると
      //   値がずれる (姉ム 1000064668)。CSV だけでは対象月時点の値を復元できないため、
      //   **正確な値は import_kyotaku_benefit_from_ky.mjs が KY伝送(項13/14)から上書きする**。
      limitStart: h.limitStart || null, limitEnd: h.limitEnd || null };
    const ex = byIns.get(key);
    if (ex) { reuse.push({ ...rec, id: ex.id }); continue; }
    let un = u.userNo;
    if (numShared.has(u.userNo) || byNum.has(u.userNo)) un = `${u.userNo}-${u.insured}`;
    toCreate.push({ ...rec, userNumber: un });
  }
  const careDist = {}; for (const [, u] of users) careDist[u.care] = (careDist[u.care] || 0) + 1;
  const noLimit = [...users.keys()].filter((k) => !(hokenByKey.get(k)?.limit)).length;
  console.log(`  既存再利用: ${reuse.length}名 / 新規作成: ${toCreate.length}名`);
  console.log(`  要介護度: ${JSON.stringify(careDist)}`);
  console.log(`  限度額なし: ${noLimit}名 / ケアマネ番号なし: ${[...users.values()].filter((u) => !u.careMgr).length}名`);
  if (toCreate[0]) console.log(`  新規サンプル: ${JSON.stringify({ un: toCreate[0].userNumber, name: toCreate[0].name, care: toCreate[0].care, limit: toCreate[0].limit, cm: [...users.values()][0].careMgr })}`);

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で clients+insurance(限度額)+assignment+care_plan(active・届出日・ケアマネ) 作成。"); return; }

  const mapping = {}; let created = 0;
  for (const k of toCreate) {
    const { data: cli, error: e1 } = await sb.from("clients").insert({
      user_number: k.userNumber, name: k.name, furigana: k.furigana, tenant_id: TENANT, status: "active", is_provisional: false,
      gender: k.gender, birth_date: k.birth, postal_code: k.postal, address: k.address, phone: k.phone, mobile: k.mobile,
      insured_number: k.insured, insurer_number: k.insurer, care_level: k.care,
      certification_start_date: k.certStart, certification_end_date: k.certEnd,
    }).select("id").single();
    if (e1) { console.error(`✗ client ${k.insured}: ${e1.message}`); process.exit(1); }
    mapping[`${k.insured}|${k.insurer}`] = cli.id; created++;
    const { error: e2 } = await sb.from("client_insurance_records").insert({
      tenant_id: TENANT, client_id: cli.id, insured_number: k.insured, insurer_number: k.insurer, care_level: k.care,
      certification_status: "認定済み", certification_start_date: k.certStart, certification_end_date: k.certEnd,
      service_limit_amount: k.limit || null, copay_rate: k.copay,
      limit_period_start: k.limitStart, limit_period_end: k.limitEnd, notes: MARK,
    });
    if (e2) console.error(`✗ insurance ${k.insured}: ${e2.message}`);
  }
  // 既存再利用client: 認定(要介護度/認定期間/限度額)と性別/氏名をマスタの最新に上書き同期。
  //   STEP1が既存を放置すると限度額null・要介護度旧・性別空 の取りこぼしになる (市原/今川等)。
  let synced = 0;
  for (const k of reuse) {
    mapping[`${k.insured}|${k.insurer}`] = k.id;
    // clients: 性別/生年/氏名 が空なら補完、care_level は最新に
    const cliPatch = { care_level: k.care };
    if (k.gender) cliPatch.gender = k.gender;
    if (k.birth) cliPatch.birth_date = k.birth;
    if (k.name && !/氏名不明/.test(k.name)) cliPatch.name = k.name;
    await sb.from("clients").update(cliPatch).eq("id", k.id);
    // insurance: 被保番+保険者 で更新。無ければ作成
    const { data: exI } = await sb.from("client_insurance_records").select("id").eq("client_id", k.id).eq("insured_number", k.insured).eq("insurer_number", k.insurer).maybeSingle();
    const insPatch = { care_level: k.care, certification_status: "認定済み", certification_start_date: k.certStart, certification_end_date: k.certEnd, service_limit_amount: k.limit || null, copay_rate: k.copay, limit_period_start: k.limitStart, limit_period_end: k.limitEnd };
    if (exI) await sb.from("client_insurance_records").update(insPatch).eq("id", exI.id);
    else await sb.from("client_insurance_records").insert({ tenant_id: TENANT, client_id: k.id, insured_number: k.insured, insurer_number: k.insurer, ...insPatch, notes: MARK });
    synced++;
  }
  if (synced) console.log(`  既存再利用の認定/性別を同期: ${synced}名`);

  // assignment + active care_plan (無ければ作成)
  let assigned = 0, plans = 0;
  for (const [key, u] of users) {
    const cid = mapping[key]; if (!cid) continue;
    const { data: exA } = await sb.from("client_office_assignments").select("id").eq("client_id", cid).eq("office_id", OFFICE_ID).maybeSingle();
    if (!exA) { const { error } = await sb.from("client_office_assignments").insert({ client_id: cid, office_id: OFFICE_ID, tenant_id: TENANT }); if (!error) assigned++; }
    const { data: exP } = await sb.from("kaigo_care_plans").select("id").eq("user_id", cid).eq("status", "active").maybeSingle();
    if (!exP) {
      const { error } = await sb.from("kaigo_care_plans").insert({
        user_id: cid, tenant_id: TENANT, status: "active", plan_type: "居宅サービス計画",
        start_date: u.certStart, end_date: u.certEnd, plan_request_date: u.requestDate, care_manager_number: u.careMgr || null,
      });
      if (!error) plans++; else console.error(`✗ care_plan ${key}: ${error.message}`);
    } else if (u.requestDate || u.careMgr) {
      await sb.from("kaigo_care_plans").update({ plan_request_date: u.requestDate, care_manager_number: u.careMgr || null }).eq("id", exP.id);
    }
  }
  // 公費 (生活保護 法別12): 公費全居宅 の当月有効行を client_kohi_records へ。
  //   公費単独(H番号)利用者の伝送警告(公費番号未登録)を防ぐ。負担者=法別12+実施機関6桁。
  const kohi = rd(CSV_KOHI); const Hko = kohi[0]; const gko = (n) => Hko.indexOf(n);
  const kByUser = new Map(), kByName = new Map(), kohiNumsByName = new Map();
  for (const c of kohi.slice(1)) {
    const cs = iso(c[gko("有効期限－開始日")]), ce = iso(c[gko("有効期限－終了日")]);
    if (!(cs && ce && cs <= MONTH_END && ce >= MONTH_START)) continue;
    const futan6 = (c[gko("負担者番号")] || "").trim().replace(/\D/g, "");
    const rec = { futansha: futan6.length === 6 ? "12" + futan6 : futan6.padStart(8, "0"), jukyusha: (c[gko("受給者番号")] || "").trim(), start: cs, end: ce, honnin: Number((c[gko("本人支払額")] || "0").replace(/\D/g, "")) || 0 };
    // 公費CSV の利用者番号は サービス計 と体系が違うことがある (袖ヶ浦 吉岡みち子=5957 vs
    // サービス計の9桁)。氏名索引も持ち、番号で引けない利用者を救済する。
    // ただし公費番号は請求内容そのものなので、**同姓同名がいる氏名では使わない**
    const nm = nameKey(c[gko("利用者名")]);
    const un = num(c[gko("利用者番号")]);
    if (nm) {
      if (!kohiNumsByName.has(nm)) kohiNumsByName.set(nm, new Set());
      kohiNumsByName.get(nm).add(un);
      if (!kByName.has(nm)) kByName.set(nm, rec);
    }
    if (!un || kByUser.has(un)) continue;
    kByUser.set(un, rec);
  }
  // 当事業所 client の user_number / 氏名 → id (氏名は当事業所内で一意な場合のみ)
  const cidByNum = new Map(), cidByName = new Map(), cidNameDup = new Set();
  const allCids = [...new Set(Object.values(mapping))];
  for (let i = 0; i < allCids.length; i += 200) {
    const { data } = await sb.from("clients").select("id, user_number, name").in("id", allCids.slice(i, i + 200));
    for (const c of data) {
      cidByNum.set(String(c.user_number), c.id);
      const nk = nameKey(c.name);
      if (!nk) continue;
      if (cidByName.has(nk)) cidNameDup.add(nk); else cidByName.set(nk, c.id);
    }
  }
  // 番号で引けた分 + 氏名でしか引けない分 をマージ (番号優先)
  const kohiTargets = new Map(); // cid → rec
  for (const [un, k] of kByUser) { const cid = cidByNum.get(un); if (cid) kohiTargets.set(cid, k); }
  let kohiNameAmbig = 0;
  for (const [nm, k] of kByName) {
    const cid = cidByName.get(nm);
    if (!cid || kohiTargets.has(cid)) continue;
    if (cidNameDup.has(nm) || (kohiNumsByName.get(nm)?.size ?? 0) > 1) { kohiNameAmbig++; continue; }
    kohiTargets.set(cid, k);
  }
  if (kohiNameAmbig) console.log(`  ⚠ 公費 氏名突合を見送り: ${kohiNameAmbig}件 (同姓同名のため。利用者番号での登録が必要)`);
  let kohiIns = 0;
  for (const [cid, k] of kohiTargets) {
    await sb.from("client_kohi_records").delete().eq("client_id", cid).eq("kohi_hobetsu", "12").eq("notes", MARK);
    const { error } = await sb.from("client_kohi_records").insert({ tenant_id: TENANT, client_id: cid, kohi_hobetsu: "12", futansha_number: k.futansha, jukyusha_number: k.jukyusha, start_date: k.start, end_date: k.end, priority: 1, honnin_futan: k.honnin, notes: MARK });
    if (!error) kohiIns++;
  }

  writeFileSync(path.join(KAIGO, `migrations/_kyotaku_office_map_${TAG}.json`), JSON.stringify(mapping));
  console.log(`✓ 完了: 新規client ${created} / 再利用同期 ${reuse.length} / assignment ${assigned} / care_plan ${plans} / 公費 ${kohiIns} → _kyotaku_office_map_${TAG}.json`);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
