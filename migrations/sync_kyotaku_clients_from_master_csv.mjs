// ============================================================================
// 居宅の利用者を **利用者マスタ CSV を正** として同期する。
//
//   MONTH=2026-06 node migrations/sync_kyotaku_clients_from_master_csv.mjs             # DRY RUN
//   MONTH=2026-06 node migrations/sync_kyotaku_clients_from_master_csv.mjs --execute
//   OFFICE=四街道 を付けるとその事業所だけ (offices.name の部分一致)
//   --force-with-warnings … 警告が出ても続行する
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
//   clients は今まで **3 つの取込の副産物**でしか作られていなかった。
//     ① MEISAI (訪問介護の稼働データ) に出た人
//     ② 伝送 KK のレセプトに出た人
//     ③ ケアプラン CSV に出た人
//   利用者マスタを正として全員を作る経路が無いので、3 つのどれにも出ない人が
//   落ちる。2026-06 の利用票突合で 15 名が見つかり、マスタ CSV と突合すると
//   **493 名**が当方に存在しなかった (2026-08-31)。
//
//   ケアプランもレセプトも「その人が居る」ことの前提であって、
//   **利用者が居るかどうかはマスタが決める**。だからマスタから作る。
//
// ── 誰が「当社の居宅の利用者」か ────────────────────────────────────────
//   介護保険CSV の 1 行 = 認定 1 世代。その行の
//     ・認定有効期間が対象月にかかる
//     ・支援事業所（正式名称）が当社の居宅事業所
//   の両方を満たす人。事業所名で決めるのでフォルダ名には依存しない。
//
//   ⚠ ほのぼの側の事業所名は表記が揺れる。実データで確認したもの:
//       半角カナ      KT在宅ｻﾎﾟｰﾄｾﾝﾀｰ / Hana居宅支援ｾﾝﾀｰおゆみ野
//       法人名の前置  株式会社ｻｰﾋﾞｽﾜﾝ　ﾑﾂﾐ居宅介護支援事業所
//       記号          *ｹｲ・ﾃｨ・ｻｰﾋﾞｽ居宅介護支援事業所 / ㈱ケイ・ティ・サービス
//       末尾の枝番    木更津ムツミ居宅支援センター　ｋ
//       **予防が別事業所名**  KT在宅ｻﾎﾟｰﾄｾﾝﾀｰ予防 / ｹｱﾌﾟﾗﾝHana船橋(予防)
//                            Hana居宅支援センター高品(予) / 予防Hanaおゆみ野居宅
//                            株式会社サービスワン　予防ムツミ居宅支援事業所
//   結び付かなかった事業所名は **必ず一覧に出す**。黙って落とすと丸ごと欠ける。
//
// ── 何を書き換えるか ────────────────────────────────────────────────────
//   ・当方に居ない人 … clients + 認定 + 事業所割当 を作る
//   ・既に居る人     … **触らない**。値の食い違いは報告するだけ
//                      (画面で人が直した値を CSV で踏み潰さないため)
//                      ただし事業所割当が無ければ足す (無いと集計から漏れる)
//
// ── 事故を防ぐ警告 (order-app の sync_clients_from_master_csv.mjs に倣う) ──
//   Level 1  CSV に必要な列が無い → 中止
//   Level 2  同じ (保険者,被保番) が CSV 内で別人に付いている → 中止
//   Level 3  新規作成が母数の 20% を超える → 停止 (--force-with-warnings で続行)
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normOfficeName } from "./_riyouhyou_pdf.mjs";

const EXECUTE = process.argv.includes("--execute");
const FORCE = process.argv.includes("--force-with-warnings");
const MONTH = process.env.MONTH || "2026-06";
const OFFICE_FILTER = process.env.OFFICE || "";
const TENANT = "kt-group";
// ほのぼのの「番号なし」センチネル。基本情報CSV内で 40 名前後が共有しているため、
// これをキーに kihonByNum を引くと無関係な人の生年月日等を拾ってしまう (2026-09-01
// 大網白里4名で実際に誤った生年月日が入りかけた)。この番号のときは基本情報を
// 引かず、氏名・保険者情報だけで登録する (誤情報を入れるより空欄の方が安全)。
const SENTINEL_USER_NUMBERS = new Set(["2147483647"]);
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const CREATED_FILE = path.join(KAIGO, "migrations/_kyotaku_sync_created.json");
const IMPORT_MARK = `[KYOTAKU-SYNC ${MONTH}]`;

if (!/^\d{4}-\d{2}$/.test(MONTH)) { console.error("MONTH は YYYY-MM"); process.exit(1); }
const MONTH_FIRST = `${MONTH}-01`;
const MONTH_LAST = (() => {
  const d = new Date(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5, 7)), 0);
  return `${MONTH}-${String(d.getDate()).padStart(2, "0")}`;
})();

const env = {};
for (const l of readFileSync(path.join(KAIGO, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

// ── CSV ────────────────────────────────────────────────────────────────────
const sjis = new TextDecoder("shift_jis");
function parseLine(line) {
  const out = []; let f = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { out.push(f); f = ""; }
    else f += c;
  }
  out.push(f); return out;
}
/** ⚠ 列位置は出力設定で変わる。必ずヘッダー名で引く (過去に 17 名落ちた) */
function readCsv(p) {
  const L = sjis.decode(readFileSync(p)).split(/\r?\n/).filter((x) => x !== "");
  if (!L.length) return { idx: {}, rows: [] };
  const h = parseLine(L[0]).map((x) => x.trim());
  const idx = {}; h.forEach((x, i) => { if (!(x in idx)) idx[x] = i; });
  return { idx, rows: L.slice(1).map(parseLine) };
}
const g = (r, idx, k) => { const i = idx[k]; return i == null ? null : (r[i] ?? "").trim() || null; };
const iso = (s) => { const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((s || "").trim()); return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null; };
const zen2han = (s) => (s || "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
/** 要介護度は全角混じりで入ってくる。NFKC で揃えないと別物として集計される */
const careLevel = (s) => zen2han((s || "").trim().normalize("NFKC")).replace(/^要介護度/, "要介護").replace(/^要支援度/, "要支援");
const normNm = (s) => (s || "").normalize("NFKC").replace(/[\s　]/g, "").replace(/[（(][^）)]*[）)]\s*$/, "").replace(/様$/, "");
const SHIKYU_GENDO = { "要支援1": 5032, "要支援2": 10531, "要介護1": 16765, "要介護2": 19705, "要介護3": 27048, "要介護4": 30938, "要介護5": 36217 };

/** ほのぼのの事業所名表記を当社の事業所名に寄せる */
function officeKey(s) {
  return normOfficeName(s)
    .replace(/^[＊*]+/, "")
    .replace(/^予[）)]/, "").replace(/^予防/, "")
    .replace(/[（(【]?予防[）)】]?/g, "")
    .replace(/[（(]予[）)]/g, "")
    .replace(/^株式会社ｻｰﾋﾞｽﾜﾝ|^株式会社サービスワン|^㈱ケイ・ティ・サービス|^\(株\)|^株式会社/, "")
    .replace(/[kｋ]$/i, "")
    .replace(/[（(][^）)]*[）)]$/, "")     // 末尾の (木・南部委託 等) を落とす
    .replace(/居宅介護支援事業所$/, "居宅支援事業所");  // ムツミの表記ゆれ吸収
}

async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** 利用者データ配下の 介護保険*.CSV / 基本情報*.CSV を集める */
function collectCsvs() {
  const base = path.join(KAIGO, "利用者データ");
  const kaigo = [], kihon = [];
  const walk = (d, depth) => {
    if (depth > 3) return;
    let ents; try { ents = readdirSync(d); } catch { return; }
    for (const n of ents) {
      const p = path.join(d, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (/^介護保険.*\.csv$/i.test(n)) kaigo.push(p);
      else if (/^基本情報.*\.csv$/i.test(n)) kihon.push(p);
    }
  };
  walk(base, 0);
  return { kaigo, kihon };
}

async function main() {
  console.log(`=== 居宅の利用者をマスタ CSV と同期 (${MONTH}) ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);

  // 当社の居宅事業所
  const { data: offices, error: oe } = await sb.from("offices").select("id, name").eq("service_type", "居宅介護支援");
  if (oe) { console.error(`✗ 事業所取得失敗: ${oe.message}`); process.exit(1); }
  const ours = (offices ?? [])
    .filter((o) => !/デモ/.test(o.name))
    .filter((o) => !OFFICE_FILTER || o.name.includes(OFFICE_FILTER))
    .map((o) => ({ ...o, key: officeKey(o.name) }));
  console.log(`対象の居宅事業所 ${ours.length}`);

  const { kaigo, kihon } = collectCsvs();
  console.log(`介護保険CSV ${kaigo.length} 本 / 基本情報CSV ${kihon.length} 本\n`);

  // ── 基本情報プール ──
  const kihonByNum = new Map();
  for (const f of kihon) {
    const { idx, rows } = readCsv(f);
    if (!("利用者番号" in idx)) continue;
    for (const r of rows) {
      const n = g(r, idx, "利用者番号");
      if (n && !kihonByNum.has(n)) kihonByNum.set(n, { idx, r });
    }
  }

  // ── 対象月に有効 かつ 担当が当社 の認定行を集める ──
  const byPair = new Map();          // 保険者|被保番 -> {office, cert{idx,r}, name}
  const unmatchedOffices = new Map();
  let missingCols = 0;
  const nameClash = [];
  for (const f of kaigo) {
    const { idx, rows } = readCsv(f);
    for (const need of ["被保険者番号", "保険者番号", "認定有効期間－開始日"]) {
      if (!(need in idx)) { missingCols++; break; }
    }
    if (!("被保険者番号" in idx) || !("保険者番号" in idx)) continue;
    const offCol = "支援事業所（正式名称）" in idx ? "支援事業所（正式名称）" : ("支援事業所" in idx ? "支援事業所" : null);
    if (!offCol) continue;
    for (const r of rows) {
      const s = iso(g(r, idx, "認定有効期間－開始日"));
      const e = iso(g(r, idx, "認定有効期間－終了日"));
      if (s && s > MONTH_LAST) continue;
      if (e && e < MONTH_FIRST) continue;
      const printed = g(r, idx, offCol);
      if (!printed) continue;
      const k = officeKey(printed);
      const hit = ours.find((o) => o.key === k) ?? ours.find((o) => k.endsWith(o.key) || o.key.endsWith(k));
      if (!hit) { unmatchedOffices.set(printed, (unmatchedOffices.get(printed) ?? 0) + 1); continue; }
      const insurer = g(r, idx, "保険者番号"), insured = g(r, idx, "被保険者番号");
      if (!insurer || !insured) continue;
      const key = `${insurer}|${insured}`;
      const name = g(r, idx, "利用者名");
      const prev = byPair.get(key);
      if (prev) {
        // 同じ番号が CSV 内で別人に付いていたら止める (誤って混ぜない)
        if (name && prev.name && normNm(name) !== normNm(prev.name)) nameClash.push(`${key}: 「${prev.name}」 と 「${name}」`);
        continue;
      }
      byPair.set(key, { office: hit, idx, r, name, insurer, insured, userNumber: g(r, idx, "利用者番号") });
    }
  }

  // ── Level 1 / 2 ──
  if (missingCols) console.log(`⚠ Level1: 必要な列が無い CSV が ${missingCols} 本 (読み飛ばした)`);
  if (nameClash.length) {
    console.error(`✗ Level2: 同じ (保険者,被保番) が CSV 内で別人に付いている ${nameClash.length} 件`);
    for (const c of nameClash.slice(0, 10)) console.error(`   ${c}`);
    console.error("  → ほのぼの側の番号の付け間違いなので、先に直してから流す");
    if (!FORCE) process.exit(2);
  }

  console.log(`当社の居宅が担当で ${MONTH} に認定が有効な利用者: ${byPair.size} 名`);
  if (unmatchedOffices.size) {
    console.log(`\n⚠ 当社の事業所に結び付かなかった名称 (他社なら無視してよい / 当社のものが混じっていたら officeKey を直す)`);
    for (const [n, c] of [...unmatchedOffices].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`   ${String(c).padStart(4)}  ${n}`);
    if (unmatchedOffices.size > 15) console.log(`   … 他 ${unmatchedOffices.size - 15} 種`);
  }

  // ── DB と突合 ──
  const insureds = [...new Set([...byPair.values()].map((p) => p.insured))];
  const have = new Map();   // 保険者|被保番 -> client_id
  for (let i = 0; i < insureds.length; i += 200) {
    const ch = insureds.slice(i, i + 200);
    for (const r of await fetchAll(() => sb.from("client_insurance_records").select("client_id, insurer_number, insured_number").in("insured_number", ch)))
      if (r.insurer_number && r.insured_number) have.set(`${r.insurer_number}|${r.insured_number}`, r.client_id);
    for (const c of await fetchAll(() => sb.from("clients").select("id, insurer_number, insured_number, deleted_at").in("insured_number", ch)))
      if (!c.deleted_at && c.insurer_number && c.insured_number) have.set(`${c.insurer_number}|${c.insured_number}`, c.id);
  }
  const toCreate = [...byPair.entries()].filter(([k]) => !have.has(k));
  const existing = [...byPair.entries()].filter(([k]) => have.has(k));
  console.log(`\n当方にある ${existing.length} 名 / 無い ${toCreate.length} 名`);

  // ── Level 3 ──
  const ratio = byPair.size ? toCreate.length / byPair.size : 0;
  if (ratio > 0.2) {
    console.log(`\n⚠ Level3: 新規作成が ${(ratio * 100).toFixed(1)}% (${toCreate.length}/${byPair.size}) と多い`);
    console.log("   CSV の出力条件 (絞込み・認定の範囲) か事業所の対応付けを疑う。");
    if (!FORCE && EXECUTE) { console.error("   → --force-with-warnings を付けない限り実行しない"); process.exit(2); }
  }

  // 既存の事業所割当
  const existIds = existing.map(([, v]) => have.get(`${v.insurer}|${v.insured}`));
  const asgByClient = new Map();
  for (let i = 0; i < existIds.length; i += 200) {
    for (const a of await fetchAll(() => sb.from("client_office_assignments").select("client_id, office_id").in("client_id", existIds.slice(i, i + 200)))) {
      if (!asgByClient.has(a.client_id)) asgByClient.set(a.client_id, new Set());
      asgByClient.get(a.client_id).add(a.office_id);
    }
  }
  const needAsg = existing.filter(([, v]) => {
    const id = have.get(`${v.insurer}|${v.insured}`);
    return !(asgByClient.get(id)?.has(v.office.id));
  });
  console.log(`既存のうち その事業所への割当が無い: ${needAsg.length} 名 (足すと画面・集計に出る)`);

  // ── 作成計画 ──
  const perOffice = {};
  for (const [, v] of toCreate) perOffice[v.office.name] = (perOffice[v.office.name] ?? 0) + 1;
  console.log("\n― 新規作成の内訳 ―");
  for (const [n, c] of Object.entries(perOffice).sort((a, b) => b[1] - a[1])) console.log(`   ${String(c).padStart(4)}  ${n}`);
  console.log("\n― 新規作成の例 (先頭10) ―");
  for (const [k, v] of toCreate.slice(0, 10)) {
    const kh = v.userNumber && !SENTINEL_USER_NUMBERS.has(v.userNumber) ? kihonByNum.get(v.userNumber) : null;
    console.log(`   ${String(v.name ?? "?").padEnd(10)} ${k} ${careLevel(g(v.r, v.idx, "要介護度")) || "?"} 生${kh ? iso(g(kh.r, kh.idx, "生年月日")) ?? "?" : "基本情報なし"} → ${v.office.name}`);
  }

  if (!EXECUTE) { console.log("\n(--execute で反映)"); return; }

  // ── 反映 ──
  const created = [];
  let ok = 0, ng = 0, asgAdded = 0;
  const existingNums = new Set((await fetchAll(() => sb.from("clients").select("user_number"))).map((c) => String(c.user_number)));

  for (const [key, v] of toCreate) {
    const kh = v.userNumber && !SENTINEL_USER_NUMBERS.has(v.userNumber) ? kihonByNum.get(v.userNumber) : null;
    const cl = careLevel(g(v.r, v.idx, "要介護度"));
    let un = v.userNumber ?? key.replace("|", "-");
    if (existingNums.has(un)) {
      // ⚠ ほのぼのの「番号なし」センチネル (2147483647 等) を同一事業所内で
      //   複数人が共有すると、事業所IDだけのsuffixでは足りず衝突する
      //   (2026-09-01 大網白里で4名が事故った)。連番を足して必ず一意にする。
      const base = `${un}-${v.office.id.slice(0, 4)}`;
      un = base;
      let seq = 2;
      while (existingNums.has(un)) un = `${base}-${seq++}`;
    }
    existingNums.add(un);

    const client = {
      user_number: un, name: v.name ?? "(氏名不明)", tenant_id: TENANT, status: "active", is_provisional: false,
      furigana: kh ? g(kh.r, kh.idx, "フリガナ") : null,
      gender: kh ? g(kh.r, kh.idx, "性別") : null,
      birth_date: kh ? iso(g(kh.r, kh.idx, "生年月日")) : null,
      postal_code: kh ? g(kh.r, kh.idx, "郵便番号") : null,
      address: kh ? g(kh.r, kh.idx, "住所") : null,
      phone: kh ? g(kh.r, kh.idx, "電話番号") : null,
      insurer_number: v.insurer, insured_number: v.insured,
      care_level: cl || null,
      certification_start_date: iso(g(v.r, v.idx, "認定有効期間－開始日")),
      certification_end_date: iso(g(v.r, v.idx, "認定有効期間－終了日")),
      benefit_rate: g(v.r, v.idx, "給付率"),
      care_manager: g(v.r, v.idx, "担当ケアマネジャー"),
      care_manager_org: g(v.r, v.idx, "支援事業所（正式名称）") ?? g(v.r, v.idx, "支援事業所"),
    };
    // 直前に重複確認 (並行取込との競合よけ)
    const { data: dup } = await sb.from("clients").select("id").eq("insurer_number", v.insurer).eq("insured_number", v.insured).is("deleted_at", null);
    if (dup?.length) continue;

    const { data: row, error: ce } = await sb.from("clients").insert(client).select("id").single();
    if (ce) { console.error(`✗ ${client.name}: ${ce.message}`); ng++; continue; }
    created.push({ id: row.id, name: client.name, key, office: v.office.name });

    const { error: ie } = await sb.from("client_insurance_records").insert({
      tenant_id: TENANT,
      effective_date: client.certification_start_date ?? MONTH_FIRST,
      insurer_number: v.insurer, insured_number: v.insured,
      insurer_name: g(v.r, v.idx, "保険者"),
      care_level: cl || null,
      certification_status: g(v.r, v.idx, "認定状況"), record_status: g(v.r, v.idx, "認定状況"),
      certification_start_date: client.certification_start_date,
      certification_end_date: client.certification_end_date,
      service_limit_amount: g(v.r, v.idx, "区分支給限度基準額（居宅ｻｰﾋﾞｽ区分）") ?? SHIKYU_GENDO[cl] ?? null,
      service_limit_period_start: iso(g(v.r, v.idx, "適用期間－開始日（居宅ｻｰﾋﾞｽ区分）")),
      service_limit_period_end: iso(g(v.r, v.idx, "適用期間－終了日（居宅ｻｰﾋﾞｽ区分）")),
      benefit_rate: g(v.r, v.idx, "給付率"),
      care_manager: g(v.r, v.idx, "担当ケアマネジャー"),
      care_manager_org: client.care_manager_org, care_office_name: client.care_manager_org,
      qualification_date: iso(g(v.r, v.idx, "資格取得日")),
      certification_date: iso(g(v.r, v.idx, "認定年月日")),
      client_id: row.id, notes: IMPORT_MARK,
    });
    if (ie) console.error(`✗ 認定 ${client.name}: ${ie.message}`);

    const { error: ae } = await sb.from("client_office_assignments").insert({
      tenant_id: TENANT, client_id: row.id, office_id: v.office.id,
      start_date: MONTH_FIRST, home_care_categories: [],
    });
    if (ae) console.error(`✗ 割当 ${client.name}: ${ae.message}`);
    ok++;
  }

  // 既存で割当が無い人に足す (値は触らない)
  for (const [, v] of needAsg) {
    const id = have.get(`${v.insurer}|${v.insured}`);
    const { error } = await sb.from("client_office_assignments").insert({
      tenant_id: TENANT, client_id: id, office_id: v.office.id,
      start_date: MONTH_FIRST, home_care_categories: [],
    });
    if (error) console.error(`✗ 割当追加 ${v.name}: ${error.message}`);
    else asgAdded++;
  }

  if (created.length) {
    const prev = existsSync(CREATED_FILE) ? JSON.parse(readFileSync(CREATED_FILE, "utf8")) : [];
    writeFileSync(CREATED_FILE, JSON.stringify([...prev, { month: MONTH, created }], null, 2), "utf8");
  }
  console.log(`\n新規作成 ${ok} 名 / 失敗 ${ng} 名 / 事業所割当を足した既存 ${asgAdded} 名`);
  if (created.length) console.log(`作成した client_id は ${path.basename(CREATED_FILE)} に記録しました`);
}

main().catch((e) => { console.error(e); process.exit(1); });
