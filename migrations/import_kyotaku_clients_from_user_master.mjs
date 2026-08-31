// ============================================================================
// 居宅の利用者マスタ (ほのぼの CSV 2 本) → clients / client_insurance_records /
//   client_office_assignments
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
//   PDF から取り込んだ支援経過・アセスメントは **事業所 + 氏名**で利用者を引く。
//   ほのぼのに居るのに当方の clients に無い人は、そこで丸ごと落ちる。
//   高品で 26 名が落ちていた (支援経過 18 / アセスメント 25、重複あり)。
//
//   ⚠ 原因は「絞込みが利用中だった」ではなかった。8/4 に置かれていた CSV は
//     **別の事業所のもの**で、「きいろG」「中抜け」「初任者研修講習」等の
//     スタッフ用ダミー登録が並んでいた。**中身を見ずに事業所名のフォルダに
//     置いてあるから正しい、と思い込まないこと。**
//
// ── ほのぼの側の出し方 ──────────────────────────────────────────────────
//   利用者管理 → CSV → 基本情報 / 介護保険
//     基本情報   処理日時点での利用登録 = **有**   (無にすると全社 23,856 名に
//                なる代わりに、その事業所の利用者が 1 人も入らない)
//     介護保険   出力範囲 = **全件** / 参照対象 = **保険と認定**
//                (既定の「有効」「認定のみ」だと過去の認定が落ちる)
//   事業所ボタンで対象事業所にチェックが入っていることも確認する。
//
//   node migrations/import_kyotaku_clients_from_user_master.mjs --office 高品   # DRY RUN
//   node migrations/import_kyotaku_clients_from_user_master.mjs --office 高品 --execute
//
// ⚠ 既存の client は **利用者番号 (user_number) で再利用**する。氏名は表記ゆれが
//   多くキーにできない (「市川 幹子(実)」「井出・井手」等)。
// ⚠ 認定は (client, 保険者, 被保番, 認定開始日) で重複を避ける。既にあれば触らない。
//   **UPDATE しない**のは、伝送から取り込んだ正しい値を上書きしないため。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const argOf = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const OFFICE_NAME = argOf("--office");
const TENANT = "kt-group";
const ROOT = fileURLToPath(new URL("../", import.meta.url));

if (!OFFICE_NAME) {
  console.error("使い方: --office <拠点名> [--execute]");
  process.exit(1);
}
const DIR = path.join(ROOT, "利用者データ", OFFICE_NAME);
const CSV_BASE = path.join(DIR, "基本情報_______.CSV");
const CSV_HOKEN = path.join(DIR, "介護保険1.CSV");

const env = {};
for (const l of readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

const sjis = new TextDecoder("shift_jis");
/** ダブルクォート対応の CSV 1 行パース */
function pl(l) {
  const o = []; let c = "", q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (q) { if (ch === '"') { if (l[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
    else { if (ch === '"') q = true; else if (ch === ",") { o.push(c); c = ""; } else c += ch; }
  }
  o.push(c); return o;
}
function readCsv(p) {
  const lines = sjis.decode(readFileSync(p)).split(/\r?\n/).filter((l) => l.trim());
  const head = pl(lines[0]);
  // ⚠ 列位置は出力設定で変わる。**必ずヘッダー名から引く**（過去に 17 名落とした）
  const col = (name) => { const i = head.indexOf(name); if (i < 0) throw new Error(`列「${name}」が ${path.basename(p)} に無い`); return i; };
  return { head, rows: lines.slice(1).map(pl), col };
}
const iso = (s) => { const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((s || "").trim()); return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null; };
const gender = (s) => (s || "").includes("女") ? "女" : (s || "").includes("男") ? "男" : null;
const t = (s) => (s || "").trim();
// ほのぼのは 要介護３ のように全角。当方は半角。NFKC で寄せないと食い違って見える
const careLevel = (s) => t(s).normalize("NFKC").replace(/\s/g, "");
// スタッフ用のダミー登録は記号で始まる (★会議 / ◆ケース会議 / ◎健康診断 …)
// ⚠ ほのぼのの動作確認用に作られた偽名も混ざる。
//   高品では「ケイティ 三郎」(利用者番号 1111111111 / 被保番 7676767676 /
//   住所空) と「ケイティ 四郎」(2020年生まれ) が居た。
//   **利用者番号がゾロ目・住所が空・氏名が社名由来**の 3 点で見分ける。
const isDummy = (name) => /^[★◆◎●■☆※]/.test(t(name)) || /^ケイテ[ィイ]/.test(t(name));
/** 利用者番号がゾロ目 (1111111111 等) のものは動作確認用 */
const isTestNumber = (u) => /^(\d)\1{6,}$/.test(u);

async function fetchAll(table, select, tweak) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(select).order("id").range(from, from + 999);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) { console.error(`✗ ${table}: ${error.message}`); process.exit(1); }
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(`=== 居宅 利用者マスタ取込 (${OFFICE_NAME}) ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);
  for (const p of [CSV_BASE, CSV_HOKEN]) {
    if (!existsSync(p)) { console.error(`✗ ${p} が無い`); process.exit(1); }
  }

  // -- 事業所 --------------------------------------------------------------
  const { data: offs, error: e1 } = await sb.from("offices")
    .select("id, name").eq("tenant_id", TENANT)
    .eq("service_type", "居宅介護支援").ilike("name", `%${OFFICE_NAME}%`);
  if (e1) { console.error(`✗ ${e1.message}`); process.exit(1); }
  if (offs?.length !== 1) {
    console.error(`✗ 居宅事業所「${OFFICE_NAME}」が ${offs?.length ?? 0} 件。1 件に絞れない`);
    for (const o of offs ?? []) console.error(`   ${o.name}`);
    process.exit(1);
  }
  const office = offs[0];
  console.log(`  事業所: ${office.name}`);

  // -- CSV -----------------------------------------------------------------
  const base = readCsv(CSV_BASE);
  const bc = base.col;
  const baseByNum = new Map();
  let dummy = 0;
  for (const c of base.rows) {
    const u = t(c[bc("利用者番号")]); if (!u) continue;
    const name = t(c[bc("利用者名")]).replace(/\s+/g, " ");
    if (isDummy(name) || isTestNumber(u)) { dummy++; continue; }
    if (!baseByNum.has(u)) baseByNum.set(u, {
      name,
      furigana: t(c[bc("フリガナ")]).replace(/\s+/g, " "),
      birth_date: iso(c[bc("生年月日")]),
      gender: gender(c[bc("性別")]),
      postal_code: t(c[bc("郵便番号")]),
      address: t(c[bc("住所")]),
      phone: t(c[bc("電話番号")]),
      mobile: t(c[bc("携帯番号")]),
    });
  }
  console.log(`  基本情報 ${base.rows.length} 行 → 利用者 ${baseByNum.size} 名${dummy ? ` (ダミー登録 ${dummy} 行を除外)` : ""}`);

  const hoken = readCsv(CSV_HOKEN);
  const hc = hoken.col;
  const certByNum = new Map();
  for (const c of hoken.rows) {
    const u = t(c[hc("利用者番号")]); if (!u) continue;
    const start = iso(c[hc("認定有効期間－開始日")]);
    const insured = t(c[hc("被保険者番号")]);
    if (!start || !insured) continue;
    if (!certByNum.has(u)) certByNum.set(u, []);
    // ⚠ 列名は client_insurance_records の実スキーマに合わせる。
    //   user_id ではなく **client_id**、cert_* ではなく **certification_***。
    certByNum.get(u).push({
      insurer_number: t(c[hc("保険者番号")]),
      insurer_name: t(c[hc("保険者")]) || null,
      insured_number: insured,
      care_level: careLevel(c[hc("要介護度")]),
      effective_date: start,
      certification_start_date: start,
      certification_end_date: iso(c[hc("認定有効期間－終了日")]),
      certification_date: iso(c[hc("認定年月日")]),
      certification_status: t(c[hc("認定状況")]) || null,
      benefit_rate: t(c[hc("給付率")]) || null,
      service_limit_amount: Number(t(c[hc("区分支給限度基準額（居宅ｻｰﾋﾞｽ区分）")])) || null,
      service_limit_period_start: iso(c[hc("適用期間－開始日（居宅ｻｰﾋﾞｽ区分）")]),
      service_limit_period_end: iso(c[hc("適用期間－終了日（居宅ｻｰﾋﾞｽ区分）")]),
      issued_date: iso(c[hc("交付年月日")]),
      qualification_date: iso(c[hc("資格取得日")]),
      insurance_valid_start: iso(c[hc("有効開始日")]),
      insurance_valid_end: iso(c[hc("有効終了日")]),
      care_manager: t(c[hc("担当ケアマネジャー")]) || null,
      care_office_name: t(c[hc("支援事業所（正式名称）")]) || null,
    });
  }
  console.log(`  介護保険 ${hoken.rows.length} 行 → 認定を持つ利用者 ${certByNum.size} 名`);

  // -- 既存 clients ---------------------------------------------------------
  // ⚠ **利用者番号だけで引いてはいけない**。ほのぼのは番号を使い回すので、
  //   短い番号 (11 / 674 等) が別人に付いていることがある。
  //   実際に踏んだ: 「11」ほのぼの=飯塚 光子 / 当方=御園 政司
  //                 「674」ほのぼの=児嶌 巴  / 当方=荻野 由紀子
  //   初版はこれで **別人の認定を 11 件コピーした**
  //   (fix_takashina_import_wrong_owner.mjs で剥がした)。
  //
  //   引き当ての優先順:
  //     ① (保険者番号, 被保険者番号) の対      ← 最も確か。被保番は保険者内で一意
  //     ② 利用者番号 かつ 生年月日が一致
  //     ③ 氏名 + 生年月日
  //   氏名だけは使わない (「市川 幹子(実)」「井出・井手」等の表記ゆれがある)。
  const existing = await fetchAll("clients", "id, user_number, name, birth_date",
    (q) => q.eq("tenant_id", TENANT));
  const byNum = new Map();
  for (const c of existing) if (c.user_number) byNum.set(String(c.user_number), c);
  const byNameBirth = new Map();
  for (const c of existing) {
    if (c.birth_date) byNameBirth.set(`${(c.name ?? "").normalize("NFKC").replace(/[\s　]/g, "")}|${c.birth_date}`, c);
  }
  // ① (保険者, 被保番) → client。既存の認定から引く
  const byInsured = new Map();
  {
    const ids = existing.map((c) => c.id);
    for (let i = 0; i < ids.length; i += 200) {
      const rows = await fetchAll("client_insurance_records",
        "client_id, insurer_number, insured_number",
        (q) => q.in("client_id", ids.slice(i, i + 200)));
      for (const r of rows) {
        if (!r.insurer_number || !r.insured_number) continue;
        const k = `${r.insurer_number}|${r.insured_number}`;
        // 同じ対が 2 人に付いていたら、それ自体が既存の壊れ。引き当てには使わない
        if (byInsured.has(k) && byInsured.get(k) !== r.client_id) byInsured.set(k, null);
        else if (!byInsured.has(k)) byInsured.set(k, r.client_id);
      }
    }
  }
  const idIndex = new Map(existing.map((c) => [c.id, c]));

  const nameKey = (s) => (s ?? "").normalize("NFKC").replace(/[\s　]/g, "");
  const toCreate = [], reused = [], birthFix = [];
  const numMismatch = [];
  for (const [u, b] of baseByNum) {
    // ① (保険者, 被保番) で引く。これが当たれば利用者番号は見ない。
    //    被保番は保険者の中で一意なので、番号の使い回しに影響されない。
    const certs = certByNum.get(u) ?? [];
    let byIns = null;
    for (const c of certs) {
      const id = byInsured.get(`${c.insurer_number}|${c.insured_number}`);
      if (id) { byIns = idIndex.get(id) ?? null; break; }
    }
    if (byIns) {
      reused.push({ ...b, csvNum: u, user_number: byIns.user_number, id: byIns.id, dbName: byIns.name });
      continue;
    }

    const hit = byNum.get(u);
    // ⚠ **生年月日が片方でも空なら、利用者番号だけで再利用してはいけない。**
    //   ほのぼのの利用者番号は 1 人を指さない (未採番は 2147483647。それ以外も
    //   使い回される) ので、生年月日で確かめられないまま番号で拾うと別人に
    //   なる。旧実装は `!b.birth_date || !hit.birth_date` を「一致」と同じ扱いに
    //   していた。氏名が一致するなら同一人物とみてよい (2026-08-31 B が是正)。
    //   同種の事故: 伝送取込が番号だけで拾い、1 人に 3 人分の認定と
    //   レセプト 39,750 円が積み上がっていた。
    const sameBirth = !!(hit && b.birth_date && hit.birth_date && hit.birth_date === b.birth_date);
    const sameName = !!(hit && nameKey(hit.name) === nameKey(b.name));
    if (hit && (sameBirth || sameName)) {
      reused.push({ ...b, csvNum: u, user_number: u, id: hit.id, dbName: hit.name });
      continue;
    }
    // 同じ番号・同じ氏名で **生年月日だけ数日ずれる**なら、当方の入力ミス。
    // 別人として作ると重複ができるので、再利用して生年月日を直す。
    // 実際に踏んだ: 川﨑 美惠子 1935-01-04 (当方) vs 1935-01-24 (ほのぼの)。
    // 保険者 121046 / 被保番 1000787265 が一致していて同一人物だった。
    if (hit && nameKey(hit.name) === nameKey(b.name) && b.birth_date && hit.birth_date
        && Math.abs(new Date(hit.birth_date) - new Date(b.birth_date)) < 40 * 864e5) {
      reused.push({ ...b, csvNum: u, user_number: u, id: hit.id, dbName: hit.name });
      birthFix.push({ id: hit.id, name: b.name, from: hit.birth_date, to: b.birth_date });
      continue;
    }
    if (hit) numMismatch.push(`${u}: ほのぼの「${b.name}」(${b.birth_date}) / 当方「${hit.name}」(${hit.birth_date})`);
    // 番号が別人に取られている、または未登録。氏名+生年月日で拾えれば再利用する
    const alt = byNameBirth.get(`${b.name.normalize("NFKC").replace(/[\s　]/g, "")}|${b.birth_date}`);
    if (alt) reused.push({ ...b, csvNum: u, user_number: alt.user_number, id: alt.id, dbName: alt.name });
    // ⚠ user_number は NOT NULL。番号が別人に取られている人には
    //   **衝突しない仮番号** `HN-<ほのぼのの番号>` を付ける。
    //   ほのぼのの番号を素直に入れると、次の取込で必ずどちらかを取り違える。
    //   本当の番号は notes に残しておく (後で人が直せるように)。
    else toCreate.push({ ...b, csvNum: u, user_number: hit ? `HN-${u}` : u, numTaken: !!hit });
  }
  if (numMismatch.length) {
    console.log(`\n  ⚠ 利用者番号が別人に使われている ${numMismatch.length} 件 (番号では引かない)`);
    for (const m of numMismatch) console.log(`     ${m}`);
  }
  console.log(`\n  既存を再利用 ${reused.length} 名 / 新規作成 ${toCreate.length} 名`);
  if (toCreate.length) {
    console.log(`  -- 新規 --`);
    for (const c of toCreate.slice(0, 30)) {
      console.log(`     ${String(c.user_number ?? "(番号なし)").padEnd(11)} ${c.name}　${c.birth_date ?? ""}`);
    }
    if (toCreate.length > 30) console.log(`     … 他 ${toCreate.length - 30} 名`);
  }

  if (birthFix.length) {
    console.log(`\n  生年月日を ほのぼの に合わせる ${birthFix.length} 名 (同番号・同姓名で数日ずれ)`);
    for (const b of birthFix) console.log(`     ${b.name}　${b.from} → ${b.to}`);
  }

  if (!EXECUTE) {
    console.log("\n※ DRY RUN。--execute で保存します。");
    return;
  }

  for (const b of birthFix) {
    const { error } = await sb.from("clients").update({ birth_date: b.to }).eq("id", b.id);
    if (error) { console.error(`✗ ${b.name} の生年月日更新に失敗: ${error.message}`); process.exit(1); }
  }

  // -- clients を作る ------------------------------------------------------
  // ⚠ キーは **ほのぼのの利用者番号 (csvNum)**。user_number は別人に取られて
  //   いると null で作るので、それでは引き当てられない。
  //   1 件ずつ入れて id を確実に対応づける (件数は数十なので許容できる)。
  const idByCsvNum = new Map();
  for (const r of reused) idByCsvNum.set(r.csvNum, r.id);
  let made = 0;
  for (const c of toCreate) {
    const { data, error } = await sb.from("clients").insert({
      // ⚠ 番号が別人に取られている人は user_number を空で作る。
      //   同じ番号を 2 人に付けると、次の取込で必ずどちらかを取り違える。
      tenant_id: TENANT, user_number: c.user_number, name: c.name,
      furigana: c.furigana || null, birth_date: c.birth_date, gender: c.gender,
      postal_code: c.postal_code || null, address: c.address || null,
      phone: c.phone || null, mobile: c.mobile || null,
      status: "active", is_facility: false,
      // ⚠ clients に notes 列は無い。仮番号を付けた事実は user_number の
      //   `HN-` 接頭辞そのものが記録になる。一覧で grep できる。
    }).select("id").single();
    if (error) { console.error(`✗ ${c.name} の作成失敗: ${error.message}`); process.exit(1); }
    idByCsvNum.set(c.csvNum, data.id);
    if (++made % 20 === 0) console.log(`  clients ${made}/${toCreate.length}`);
  }
  if (toCreate.length) console.log(`  clients ${made}/${toCreate.length}`);

  const idOf = (u) => idByCsvNum.get(u) ?? null;
  const allNums = [...baseByNum.keys()].filter((u) => idOf(u));

  // -- 事業所への割当 ------------------------------------------------------
  // ⚠ これが無いと「自事業所」タブに出ず、PDF 取込の引き当ても効かない
  const asg = await fetchAll("client_office_assignments", "client_id",
    (q) => q.eq("office_id", office.id));
  const assigned = new Set(asg.map((a) => a.client_id));
  const newAsg = allNums.map(idOf).filter((id) => !assigned.has(id))
    .map((client_id) => ({ tenant_id: TENANT, client_id, office_id: office.id }));
  if (newAsg.length) {
    for (let i = 0; i < newAsg.length; i += 200) {
      const { error } = await sb.from("client_office_assignments").insert(newAsg.slice(i, i + 200));
      if (error) { console.error(`✗ 割当失敗: ${error.message}`); process.exit(1); }
    }
  }
  console.log(`  事業所への割当 追加 ${newAsg.length} 件 (既に ${assigned.size} 件)`);

  // -- 認定 ----------------------------------------------------------------
  const ids = allNums.map(idOf);
  const haveCerts = new Set();
  for (let i = 0; i < ids.length; i += 100) {
    const rows = await fetchAll("client_insurance_records",
      "client_id, insurer_number, insured_number, certification_start_date",
      (q) => q.in("client_id", ids.slice(i, i + 100)));
    for (const r of rows) haveCerts.add(`${r.client_id}|${r.insurer_number}|${r.insured_number}|${r.certification_start_date}`);
  }
  const certRows = [];
  for (const u of allNums) {
    const id = idOf(u);
    for (const c of certByNum.get(u) ?? []) {
      const k = `${id}|${c.insurer_number}|${c.insured_number}|${c.certification_start_date}`;
      if (haveCerts.has(k)) continue;
      haveCerts.add(k);
      certRows.push({ tenant_id: TENANT, client_id: id, ...c });
    }
  }
  if (certRows.length) {
    for (let i = 0; i < certRows.length; i += 200) {
      const { error } = await sb.from("client_insurance_records").insert(certRows.slice(i, i + 200));
      if (error) { console.error(`✗ 認定の保存失敗: ${error.message}`); process.exit(1); }
      console.log(`  認定 ${Math.min(i + 200, certRows.length)}/${certRows.length}`);
    }
  }
  console.log(`  認定 追加 ${certRows.length} 件`);

  console.log(`\n✓ 完了: 新規 ${toCreate.length} 名 / 割当 ${newAsg.length} 件 / 認定 ${certRows.length} 件`);
}

main();
