// ============================================================================
// 居宅の利用票には載っているのに **当システムに存在しない利用者** を、
// ほのぼのの利用者マスタ CSV から作る。
//
//   MONTH=2026-06 node migrations/import_kyotaku_clients_from_master_csv.mjs            # DRY RUN
//   MONTH=2026-06 node migrations/import_kyotaku_clients_from_master_csv.mjs --execute
//   AREA=K姉 を付けるとその拠点だけ
//
// ── なぜ落ちるのか (2026-08-31 に原因特定) ────────────────────────────────
//   居宅の利用者は 2 経路でしか作られていない。
//     ① import_meisai_step1_clients.mjs  … **MEISAI (訪問介護の稼働データ) に
//        出てくる利用者番号だけ**が対象。居宅だけの人は通らない
//     ② import_kyotaku_claims_from_kk.mjs … 伝送 KK のレセプトから作る
//   つまり **レセプトが無い居宅利用者は永久に作られない**。
//
//   2026-06 の利用票 1,876 名のうち 15 名がこれに当たった。内訳:
//     要支援 5 名  … 予防プラン (包括からの委託)。国保連を通らないので KK に出ない
//     要介護 10 名 … 月遅れ請求。8/10 送信の KK (14 事業所ぶん未取込) に入っている
//
//   利用者マスタ CSV には 15 名とも入っていたので、そこから作れば埋まる。
//
// ── 引き当てのキー ──────────────────────────────────────────────────────
//   PDF も CSV も **(保険者番号, 被保険者番号) の対**で引く。
//   被保険者番号は保険者の中でしか一意でないため、番号だけで引くと別人に当たる。
//   実例: 大網 野口 照恵 (124248|0000035584) の被保番は、当方では別人の
//         伊東 八重子 (122101) が持っている。
//
// ── 作らないもの ────────────────────────────────────────────────────────
//   ・(保険者, 被保番) が既にある人           … 何もしない
//   ・CSV に見つからない人                    … 作らない (素性が分からないため)
//   ・PDF と CSV で氏名が食い違う人           … 作らない (別人の可能性)
//   推測でレコードを作ると請求に紐づく人を汚すので、迷ったら作らない側に倒す。
//
//   作成した client_id は migrations/_kyotaku_clients_created.json に記録する
//   (取り消したくなったときのため)。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRiyouhyouPdfs, parseRiyouhyouPages, normOfficeName } from "./_riyouhyou_pdf.mjs";
import { extractGrid, pickIdentity } from "./_riyouhyou_grid.mjs";

const EXECUTE = process.argv.includes("--execute");
const MONTH = process.env.MONTH || "2026-06";
const AREA = process.env.AREA || "";
const TENANT = "kt-group";
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const YYYYMM = MONTH.replace("-", "");
const IMPORT_MARK = `[KYOTAKU-CSV ${MONTH}]`;
const CREATED_FILE = path.join(KAIGO, "migrations/_kyotaku_clients_created.json");

if (!/^\d{4}-\d{2}$/.test(MONTH)) {
  console.error("MONTH は YYYY-MM で指定する");
  process.exit(1);
}

function loadEnv() {
  const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8");
  const e = {};
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return e;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ── CSV (Shift_JIS・ダブルクォート囲い) ────────────────────────────────────
const sjis = new TextDecoder("shift_jis");
function parseLine(line) {
  const out = [];
  let f = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(f); f = ""; }
    else f += c;
  }
  out.push(f);
  return out;
}
/** ⚠ 列位置は出力設定で変わるので **必ずヘッダー名で引く** (過去に 17 名落ちた) */
function readCsv(p) {
  const lines = sjis.decode(readFileSync(p)).split(/\r?\n/).filter((l) => l !== "");
  if (!lines.length) return { idx: {}, rows: [] };
  const header = parseLine(lines[0]).map((h) => h.trim());
  const idx = {};
  header.forEach((h, i) => { if (!(h in idx)) idx[h] = i; });
  return { idx, rows: lines.slice(1).map(parseLine) };
}

const val = (row, idx, name) => {
  const i = idx[name];
  return i == null ? null : (row[i] ?? "").trim() || null;
};
const zen2han = (s) => (s || "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
const isoDate = (s) => {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((s || "").trim());
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
};
const normNm = (s) => (s || "").normalize("NFKC").replace(/[\s　]/g, "").replace(/[（(][^）)]*[）)]\s*$/, "").replace(/様$/, "");
const careLevel = (s) => zen2han((s || "").trim()).replace(/^要介護度/, "要介護").replace(/^要支援度/, "要支援");
/** 区分支給限度基準額 (単位)。CSV に無いときに要介護度から引く */
const SHIKYU_GENDO = {
  "要支援1": 5032, "要支援2": 10531, "要介護1": 16765, "要介護2": 19705,
  "要介護3": 27048, "要介護4": 30938, "要介護5": 36217,
};

/** PostgREST の 1000 行上限を超えて全件取る */
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

/** PDF のテキスト・語を PyMuPDF で取り出す */
function extractPages(pdfPath) {
  const py = [
    "import fitz, json, sys",
    "d = fitz.open(sys.argv[1])",
    "texts, words = [], []",
    "for i in range(d.page_count):",
    "    p = d[i]",
    "    texts.append(p.get_text())",
    '    words.append([{"x": w[0], "y": w[1], "t": w[4]} for w in p.get_text("words")])',
    'print(json.dumps({"texts": texts, "words": words}, ensure_ascii=False))',
  ].join("\n");
  return JSON.parse(execFileSync("python", ["-c", py, pdfPath], {
    encoding: "utf8", maxBuffer: 1 << 26, env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  }));
}

// ── 1. 利用票 PDF から「その月にサービスを使った人」を集める ────────────────
function readRiyouhyou() {
  const base = path.join(KAIGO, "利用者データ");
  const areas = (AREA ? [AREA] : readdirSync(base))
    .map((a) => ({ area: a, dir: path.join(base, a, YYYYMM, "居宅") }))
    .filter((x) => existsSync(x.dir));

  const people = new Map();   // 保険者|被保番 -> {…}
  for (const { area, dir } of areas) {
    const { files } = findRiyouhyouPdfs(dir);
    for (const f of files) {
      const { texts, words } = extractPages(f);
      for (let i = 0; i < words.length; i++) {
        if (!extractGrid(words[i])) continue;
        const id = pickIdentity(words[i]);
        const who = parseRiyouhyouPages([texts[i]], [words[i]])[0] ?? null;
        if (who?.month && who.month !== MONTH) continue;
        if (!id.insurer || !id.insured) continue;
        const key = `${id.insurer}|${id.insured}`;
        if (people.has(key)) continue;
        people.set(key, {
          area, key, name: id.name ?? who?.name ?? "",
          insurer: id.insurer, insured: id.insured,
          careLevel: who?.careLevel ?? null,
          officeName: who?.officeName ?? null,
        });
      }
    }
  }
  return { people, areas: areas.map((a) => a.area) };
}

// ── 2. 利用者マスタ CSV をプールする ───────────────────────────────────────
/** 利用者データ配下の 介護保険*.CSV / 基本情報*.CSV を全部集める */
function collectCsvs() {
  const base = path.join(KAIGO, "利用者データ");
  const kaigo = [], kihon = [];
  const walk = (d, depth) => {
    if (depth > 3) return;
    let ents;
    try { ents = readdirSync(d); } catch { return; }
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

function buildPools() {
  const { kaigo, kihon } = collectCsvs();
  // (保険者番号, 被保険者番号) -> 認定行。対象月に有効なものを優先する。
  const insByPair = new Map();
  for (const f of kaigo) {
    const { idx, rows } = readCsv(f);
    if (!("被保険者番号" in idx) || !("保険者番号" in idx)) continue;
    for (const r of rows) {
      const insured = val(r, idx, "被保険者番号");
      const insurer = val(r, idx, "保険者番号");
      if (!insured || !insurer) continue;
      const rec = { file: path.basename(f), idx, r };
      const key = `${insurer}|${insured}`;
      const cur = insByPair.get(key) ?? [];
      cur.push(rec);
      insByPair.set(key, cur);
    }
  }
  // 利用者番号 -> 基本情報行 / 氏名+生年月日 -> 基本情報行
  const kihonByNum = new Map(), kihonByNameBirth = new Map();
  for (const f of kihon) {
    const { idx, rows } = readCsv(f);
    if (!("利用者番号" in idx)) continue;
    for (const r of rows) {
      const num = val(r, idx, "利用者番号");
      const nm = val(r, idx, "利用者名");
      const bd = isoDate(val(r, idx, "生年月日"));
      const rec = { file: path.basename(f), idx, r };
      if (num && !kihonByNum.has(num)) kihonByNum.set(num, rec);
      if (nm && bd) kihonByNameBirth.set(`${normNm(nm)}|${bd}`, rec);
    }
  }
  return { insByPair, kihonByNum, kihonByNameBirth, fileCount: kaigo.length + kihon.length };
}

/** 対象月に有効な認定行を選ぶ (無ければ一番新しいもの) */
function pickCert(recs) {
  const first = `${MONTH}-01`;
  const inRange = recs.filter((x) => {
    const s = isoDate(val(x.r, x.idx, "認定有効期間－開始日"));
    const e = isoDate(val(x.r, x.idx, "認定有効期間－終了日"));
    return (!s || s <= `${MONTH}-31`) && (!e || e >= first);
  });
  const pool = inRange.length ? inRange : recs;
  return pool.sort((a, b) => String(isoDate(val(b.r, b.idx, "認定有効期間－開始日")) ?? "")
    .localeCompare(String(isoDate(val(a.r, a.idx, "認定有効期間－開始日")) ?? "")))[0];
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== 利用票にいるが未登録の居宅利用者を CSV から作る (${MONTH}) ===`);
  console.log(EXECUTE ? "*** 本番実行 ***" : "*** DRY RUN (--execute で反映) ***");
  console.log("");

  const { people, areas } = readRiyouhyou();
  if (!people.size) { console.error(`✗ 利用者データ/<拠点>/${YYYYMM}/居宅/ に利用票がない`); process.exit(1); }
  console.log(`利用票の利用者 ${people.size} 名 (${areas.join(" / ")})`);

  // 既存 client を (保険者, 被保番) で引く
  const insureds = [...new Set([...people.values()].map((p) => p.insured))];
  const have = new Set();
  for (let i = 0; i < insureds.length; i += 200) {
    const chunk = insureds.slice(i, i + 200);
    for (const r of await fetchAll(() => sb.from("client_insurance_records").select("insurer_number, insured_number").in("insured_number", chunk)))
      if (r.insurer_number && r.insured_number) have.add(`${r.insurer_number}|${r.insured_number}`);
    for (const c of await fetchAll(() => sb.from("clients").select("insurer_number, insured_number, deleted_at").in("insured_number", chunk)))
      if (!c.deleted_at && c.insurer_number && c.insured_number) have.add(`${c.insurer_number}|${c.insured_number}`);
  }
  const missing = [...people.values()].filter((p) => !have.has(p.key));
  console.log(`当方に無い          ${missing.length} 名`);
  if (!missing.length) { console.log("作るものはありません。"); return; }

  const pools = buildPools();
  console.log(`利用者マスタ CSV     ${pools.fileCount} 本を走査\n`);

  // 居宅事業所 (印字された事業所名から引く)
  const { data: offices, error: oe } = await sb.from("offices").select("id, name, service_type").eq("service_type", "居宅介護支援");
  if (oe) { console.error(`✗ 事業所取得失敗: ${oe.message}`); process.exit(1); }
  const byName = new Map((offices ?? []).map((o) => [normOfficeName(o.name), o]));
  // PDF には法人名が前置されることがあるので、完全一致 → 末尾一致 (最長優先) で当てる
  const resolveOffice = (printed) => {
    const key = normOfficeName(printed ?? "");
    if (!key) return null;
    if (byName.has(key)) return byName.get(key);
    return (offices ?? [])
      .filter((o) => key.endsWith(normOfficeName(o.name)))
      .sort((a, b) => normOfficeName(b.name).length - normOfficeName(a.name).length)[0] ?? null;
  };

  // user_number の衝突を避けるため既存を引く
  const existingNums = new Set((await fetchAll(() => sb.from("clients").select("user_number"))).map((c) => String(c.user_number)));

  const plan = [], skipped = [];
  for (const p of missing) {
    const recs = pools.insByPair.get(p.key);
    if (!recs?.length) { skipped.push(`${p.area} ${p.name} (${p.key}) — CSV に無い`); continue; }
    const cert = pickCert(recs);
    const num = val(cert.r, cert.idx, "利用者番号");
    const csvName = val(cert.r, cert.idx, "利用者名");
    // 氏名が食い違う = 別人の可能性。作らない
    if (csvName && normNm(csvName) !== normNm(p.name)) {
      skipped.push(`${p.area} 利用票「${p.name}」 vs CSV「${csvName}」 (${p.key}) — 氏名不一致`);
      continue;
    }
    const kihon = (num && pools.kihonByNum.get(num)) ?? null;
    const office = resolveOffice(p.officeName);
    if (!office) { skipped.push(`${p.area} ${p.name} — 事業所が引けない (印字「${p.officeName}」)`); continue; }

    const cl = careLevel(val(cert.r, cert.idx, "要介護度"));
    const bd = kihon ? isoDate(val(kihon.r, kihon.idx, "生年月日")) : null;
    let userNumber = num ?? `${p.insurer}-${p.insured}`;
    if (existingNums.has(userNumber)) userNumber = `${userNumber}-kyotaku`;
    existingNums.add(userNumber);

    const client = {
      user_number: userNumber, name: csvName ?? p.name, tenant_id: TENANT,
      status: "active", is_provisional: false,
      furigana: kihon ? val(kihon.r, kihon.idx, "フリガナ") : null,
      gender: kihon ? val(kihon.r, kihon.idx, "性別") : null,
      birth_date: bd,
      postal_code: kihon ? val(kihon.r, kihon.idx, "郵便番号") : null,
      address: kihon ? val(kihon.r, kihon.idx, "住所") : null,
      phone: kihon ? val(kihon.r, kihon.idx, "電話番号") : null,
      insured_number: p.insured, insurer_number: p.insurer,
      care_level: cl || null,
      certification_start_date: isoDate(val(cert.r, cert.idx, "認定有効期間－開始日")),
      certification_end_date: isoDate(val(cert.r, cert.idx, "認定有効期間－終了日")),
      benefit_rate: val(cert.r, cert.idx, "給付率"),
      care_manager: val(cert.r, cert.idx, "担当ケアマネジャー"),
      care_manager_org: val(cert.r, cert.idx, "支援事業所（正式名称）") ?? val(cert.r, cert.idx, "支援事業所"),
    };
    const ins = {
      tenant_id: TENANT,
      effective_date: isoDate(val(cert.r, cert.idx, "認定有効期間－開始日")) ?? `${MONTH}-01`,
      insured_number: p.insured, insurer_number: p.insurer,
      insurer_name: val(cert.r, cert.idx, "保険者"),
      care_level: cl || null,
      certification_status: val(cert.r, cert.idx, "認定状況"),
      record_status: val(cert.r, cert.idx, "認定状況"),
      certification_start_date: isoDate(val(cert.r, cert.idx, "認定有効期間－開始日")),
      certification_end_date: isoDate(val(cert.r, cert.idx, "認定有効期間－終了日")),
      service_limit_amount: val(cert.r, cert.idx, "区分支給限度基準額（居宅ｻｰﾋﾞｽ区分）") ?? SHIKYU_GENDO[cl] ?? null,
      service_limit_period_start: isoDate(val(cert.r, cert.idx, "適用期間－開始日（居宅ｻｰﾋﾞｽ区分）")),
      service_limit_period_end: isoDate(val(cert.r, cert.idx, "適用期間－終了日（居宅ｻｰﾋﾞｽ区分）")),
      benefit_rate: val(cert.r, cert.idx, "給付率"),
      care_manager: val(cert.r, cert.idx, "担当ケアマネジャー"),
      care_manager_org: val(cert.r, cert.idx, "支援事業所（正式名称）") ?? val(cert.r, cert.idx, "支援事業所"),
      care_office_name: val(cert.r, cert.idx, "支援事業所（正式名称）") ?? val(cert.r, cert.idx, "支援事業所"),
      qualification_date: isoDate(val(cert.r, cert.idx, "資格取得日")),
      certification_date: isoDate(val(cert.r, cert.idx, "認定年月日")),
      notes: IMPORT_MARK,
    };
    plan.push({ p, office, client, ins, src: cert.file, kihonSrc: kihon?.file ?? null });
  }

  console.log("― 作成予定 ―");
  for (const t of plan) {
    console.log(`  ${t.p.area.padEnd(6)} ${t.client.name.padEnd(10)} ${t.client.care_level ?? "?"}  ` +
      `${t.p.key}  生${t.client.birth_date ?? "?"}  → ${t.office.name}`);
    console.log(`     出典: ${t.src}${t.kihonSrc ? " / " + t.kihonSrc : " / 基本情報なし"}`);
  }
  if (skipped.length) {
    console.log("\n― 作らないもの ―");
    for (const s of skipped) console.log(`  ${s}`);
  }
  console.log(`\n作成 ${plan.length} 名 / 見送り ${skipped.length} 名`);

  if (!EXECUTE) { console.log("\n(--execute で反映)"); return; }

  const created = [];
  let ok = 0, ng = 0;
  for (const t of plan) {
    // 直前にもう一度、二重登録になっていないか確認する
    const { data: dup, error: de } = await sb.from("clients")
      .select("id").eq("insurer_number", t.p.insurer).eq("insured_number", t.p.insured).is("deleted_at", null);
    if (de) { console.error(`✗ 重複確認失敗 ${t.client.name}: ${de.message}`); ng++; continue; }
    if (dup?.length) { console.log(`  = ${t.client.name}: 既にいるので作らない`); continue; }

    const { data: row, error: ce } = await sb.from("clients").insert(t.client).select("id").single();
    if (ce) { console.error(`✗ client 作成失敗 ${t.client.name}: ${ce.message}`); ng++; continue; }
    const cid = row.id;
    created.push({ id: cid, name: t.client.name, key: t.p.key, area: t.p.area });

    const { error: ie } = await sb.from("client_insurance_records").insert({ ...t.ins, client_id: cid });
    if (ie) console.error(`✗ 認定 作成失敗 ${t.client.name}: ${ie.message}`);

    // ⚠ これが無いと画面の「自事業所」タブに出ない
    const { error: ae } = await sb.from("client_office_assignments").insert({
      tenant_id: TENANT, client_id: cid, office_id: t.office.id,
      start_date: `${MONTH}-01`, home_care_categories: [],
    });
    if (ae) console.error(`✗ 事業所割当 失敗 ${t.client.name}: ${ae.message}`);
    ok++;
  }
  if (created.length) {
    const prev = existsSync(CREATED_FILE) ? JSON.parse(readFileSync(CREATED_FILE, "utf8")) : [];
    writeFileSync(CREATED_FILE, JSON.stringify([...prev, { month: MONTH, at: IMPORT_MARK, created }], null, 2), "utf8");
    console.log(`\n作成した client_id は ${path.basename(CREATED_FILE)} に記録しました`);
  }
  console.log(`\n作成 ${ok} 名 / 失敗 ${ng} 名`);
  console.log("→ このあと 利用票の取込をもう一度流すと、この人たちの帳票が入ります:");
  console.log(`   MONTH=${MONTH} node migrations/import_riyouhyou_service_usage.mjs --execute`);
}

main().catch((e) => { console.error(e); process.exit(1); });
