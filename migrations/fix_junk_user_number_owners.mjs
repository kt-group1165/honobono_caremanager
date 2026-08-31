// ============================================================================
// ゴミ利用者番号 2147483647 に集まった **別人のデータ**を持ち主に戻す。
//
//   node migrations/fix_junk_user_number_owners.mjs             # DRY RUN
//   node migrations/fix_junk_user_number_owners.mjs --execute
//
// ── 何が起きているか ────────────────────────────────────────────────────
//   ほのぼのは利用者番号が未採番の人に **2147483647** (int32 の最大値) を入れる。
//   これは 1 人を指す番号ではなく、**複数人が共有するプレースホルダ**。
//   取込がこれで引き当てたため、当方では 1 人の client に別人が積み上がった。
//
//   当方 「佐藤 喜美子」(生1936-01-26 / user_number=2147483647) の中身:
//     認定 4 件
//       121061|1002199030 要支援2  … 狩野 絹代     (Hana居宅支援センター高品 予防)
//       122101|0000164640 要介護2  … 佐藤 喜美子   ← 本人
//       122192|1000100960 要介護3  … 齋藤 夫美雄   (ムツミ居宅介護支援事業所)
//       122291|1212121212 要介護1  … 高橋 良雄     (ＫＴ在宅サポートセンター)
//     レセプト 2 件 = 39,750 円  どちらも本人のものではない
//       2026-07  122192|1000100960  20,009 円  → 齋藤 夫美雄
//       2026-07  122291|1212121212  19,741 円  → 高橋 良雄
//     事業所割当 4 件 (リンクスヘルパー / KT在宅 / ムツミ居宅 / Hana高品)
//
//   持ち主は利用者マスタ CSV で確定した。全員 利用者番号は 2147483647 だが
//   **(保険者番号, 被保険者番号) の対では一意**に決まる。
//   ⚠ 1212121212 も ほのぼのの仮被保番で 3 人が使っている
//     (122069 荒井せつ子 / 122259 岩﨑歌子 / 122291 高橋良雄)。
//     やはり保険者との対で切り分ける。
//
// ── やること ────────────────────────────────────────────────────────────
//   ・持ち主の client が無ければ CSV から作る
//   ・認定・レセプト・事業所割当を持ち主へ付け替える
//   ・本人 (佐藤 喜美子) の分と、氏名が本人の帳票 (第1表 2 件) は触らない
//
// ── 安全策 ──────────────────────────────────────────────────────────────
//   ・対象は下の OWNERS に明示した 3 件だけ。走査して自動判定はしない
//   ・実行前に現在値が想定どおりか確認し、違えば触らずに中止する
//   ・変更前の値を migrations/_junk_user_number_fix_backup.json に残す
//
// ── 根本原因 (別途直すべき) ────────────────────────────────────────────
//   伝送取込 (import_kyotaku_claims_from_kk.mjs) が引き当てに失敗したとき、
//   利用者番号で拾って既存 client にぶら下げている。2147483647 のような
//   **共有プレースホルダを一意キーとして使わない**ようにする必要がある。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const TENANT = "kt-group";
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const BACKUP = path.join(KAIGO, "migrations/_junk_user_number_fix_backup.json");
const JUNK_NUMBER = "2147483647";

/** 佐藤 喜美子 に紛れ込んでいる別人。CSV で裏を取ったもの */
const OWNERS = [
  { insurer: "121061", insured: "1002199030", name: "狩野 絹代",  office: "Ｈａｎａ居宅支援センター高品" },
  { insurer: "122192", insured: "1000100960", name: "齋藤 夫美雄", office: "ムツミ居宅介護支援事業所" },
  { insurer: "122291", insured: "1212121212", name: "高橋 良雄",  office: "ＫＴ在宅サポートセンター" },
];
/** 本人のもの。触らない */
const SELF = { insurer: "122101", insured: "0000164640", name: "佐藤 喜美子" };

const env = {};
for (const l of readFileSync(path.join(KAIGO, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

// ── CSV (Shift_JIS) ────────────────────────────────────────────────────────
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
function readCsv(p) {
  const L = sjis.decode(readFileSync(p)).split(/\r?\n/).filter((x) => x !== "");
  if (!L.length) return { idx: {}, rows: [] };
  const h = parseLine(L[0]).map((x) => x.trim());
  const idx = {}; h.forEach((x, i) => { if (!(x in idx)) idx[x] = i; });
  return { idx, rows: L.slice(1).map(parseLine) };
}
const g = (r, idx, k) => { const i = idx[k]; return i == null ? null : (r[i] ?? "").trim() || null; };
const iso = (s) => { const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((s ?? "").trim()); return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null; };
const careLevel = (s) => (s ?? "").trim().normalize("NFKC").replace(/^要介護度/, "要介護").replace(/^要支援度/, "要支援");
const normNm = (s) => (s ?? "").normalize("NFKC").replace(/[\s　]/g, "");

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
  console.log(`=== ゴミ利用者番号 ${JUNK_NUMBER} に集まった別人のデータを戻す ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);

  const { data: junk, error: je } = await sb.from("clients")
    .select("*").eq("user_number", JUNK_NUMBER).is("deleted_at", null);
  if (je) { console.error(`✗ ${je.message}`); process.exit(1); }
  if (!junk?.length) { console.log("対象の client がいない → 是正済みとみなす"); return; }
  if (junk.length > 1) { console.error(`✗ user_number=${JUNK_NUMBER} の client が ${junk.length} 人。手当てが必要`); process.exit(2); }
  const host = junk[0];
  console.log(`受け皿になっている client: ${host.name} (生${host.birth_date} / ${host.insurer_number}|${host.insured_number})`);
  if (normNm(host.name) !== normNm(SELF.name)) {
    console.error(`✗ 想定 (${SELF.name}) と違う。中身を確認してから直すこと`); process.exit(2);
  }

  // CSV から持ち主の素性を引く
  const { kaigo, kihon } = collectCsvs();
  const certByPair = new Map(), kihonByName = new Map();
  for (const f of kaigo) {
    const { idx, rows } = readCsv(f);
    if (!("被保険者番号" in idx) || !("保険者番号" in idx)) continue;
    for (const r of rows) {
      const k = `${g(r, idx, "保険者番号")}|${g(r, idx, "被保険者番号")}`;
      const cur = certByPair.get(k) ?? [];
      cur.push({ idx, r });
      certByPair.set(k, cur);
    }
  }
  for (const f of kihon) {
    const { idx, rows } = readCsv(f);
    if (!("利用者名" in idx)) continue;
    for (const r of rows) {
      const nm = normNm(g(r, idx, "利用者名"));
      if (nm && !kihonByName.has(nm)) kihonByName.set(nm, { idx, r });
    }
  }

  const { data: offices } = await sb.from("offices").select("id, name").eq("service_type", "居宅介護支援");
  const backup = [];
  let moved = 0;

  for (const own of OWNERS) {
    const key = `${own.insurer}|${own.insured}`;
    console.log(`\n── ${own.name}  ${key}`);

    const { data: cert } = await sb.from("client_insurance_records")
      .select("*").eq("client_id", host.id).eq("insurer_number", own.insurer).eq("insured_number", own.insured).maybeSingle();
    if (!cert) { console.log("   受け皿に認定が無い → 是正済みとみなす"); continue; }

    // CSV で氏名が一致するか確認 (取り違えを防ぐ)
    const csvRows = certByPair.get(key) ?? [];
    const csvName = csvRows.map((x) => g(x.r, x.idx, "利用者名")).find(Boolean);
    if (!csvName || normNm(csvName) !== normNm(own.name)) {
      console.error(`   ✗ CSV の氏名が「${csvName ?? "見つからず"}」で想定と違う → 触らない`);
      continue;
    }

    // 持ち主の client を用意する
    let { data: owner } = await sb.from("clients")
      .select("id, name").eq("insurer_number", own.insurer).eq("insured_number", own.insured).is("deleted_at", null).maybeSingle();
    if (!owner) {
      const kh = kihonByName.get(normNm(own.name));
      const newClient = {
        user_number: `${own.insurer}-${own.insured}`, name: own.name, tenant_id: TENANT,
        status: "active", is_provisional: false,
        birth_date: kh ? iso(g(kh.r, kh.idx, "生年月日")) : null,
        furigana: kh ? g(kh.r, kh.idx, "フリガナ") : null,
        gender: kh ? g(kh.r, kh.idx, "性別") : null,
        postal_code: kh ? g(kh.r, kh.idx, "郵便番号") : null,
        address: kh ? g(kh.r, kh.idx, "住所") : null,
        phone: kh ? g(kh.r, kh.idx, "電話番号") : null,
        insurer_number: own.insurer, insured_number: own.insured,
        care_level: cert.care_level,
        certification_start_date: cert.certification_start_date,
        certification_end_date: cert.certification_end_date,
      };
      console.log(`   client を作る: ${own.name} 生${newClient.birth_date ?? "?"} ${careLevel(cert.care_level)}`);
      if (EXECUTE) {
        const { data: row, error } = await sb.from("clients").insert(newClient).select("id").single();
        if (error) { console.error(`   ✗ 作成失敗: ${error.message}`); continue; }
        owner = { id: row.id, name: own.name };
        backup.push({ action: "created_client", id: row.id, name: own.name });
      }
    } else {
      console.log(`   既存の client を使う (${owner.id.slice(0, 8)})`);
    }

    const { data: claims } = await sb.from("kaigo_care_support_claims")
      .select("id, billing_month, total_amount").eq("user_id", host.id).eq("insured_number", own.insured).eq("insurer_number", own.insurer);
    console.log(`   認定 1 件 / レセプト ${claims?.length ?? 0} 件 ${(claims ?? []).map((c) => `${c.billing_month} ${c.total_amount}円`).join(" ")} を移す`);

    const office = (offices ?? []).find((o) => o.name === own.office);
    if (office) console.log(`   事業所割当 → ${office.name}`);

    if (!EXECUTE || !owner) { moved++; continue; }

    backup.push({ action: "move_cert", id: cert.id, from: host.id, to: owner.id });
    const { error: ce } = await sb.from("client_insurance_records").update({ client_id: owner.id }).eq("id", cert.id);
    if (ce) { console.error(`   ✗ 認定の付け替え失敗: ${ce.message}`); continue; }

    for (const c of claims ?? []) {
      backup.push({ action: "move_claim", id: c.id, from: host.id, to: owner.id });
      const { error } = await sb.from("kaigo_care_support_claims").update({ user_id: owner.id }).eq("id", c.id);
      if (error) console.error(`   ✗ レセプト付け替え失敗 ${c.billing_month}: ${error.message}`);
    }

    if (office) {
      const { data: has } = await sb.from("client_office_assignments").select("client_id").eq("client_id", owner.id).eq("office_id", office.id).maybeSingle();
      if (!has) {
        const { error } = await sb.from("client_office_assignments").insert({
          tenant_id: TENANT, client_id: owner.id, office_id: office.id,
          start_date: cert.certification_start_date ?? "2026-06-01", home_care_categories: [],
        });
        if (error) console.error(`   ✗ 割当の作成失敗: ${error.message}`);
      }
      // 受け皿から、その事業所の割当を外す (本人のものではないため)
      const { data: hostAsg } = await sb.from("client_office_assignments").select("id").eq("client_id", host.id).eq("office_id", office.id).maybeSingle();
      if (hostAsg) {
        backup.push({ action: "delete_host_assignment", id: hostAsg.id, client_id: host.id, office_id: office.id });
        const { error } = await sb.from("client_office_assignments").delete().eq("id", hostAsg.id);
        if (error) console.error(`   ✗ 受け皿の割当削除に失敗: ${error.message}`);
      }
    }
    moved++;
  }

  console.log(`\n是正対象 ${moved} 件`);
  console.log(`⚠ 佐藤 喜美子 本人の分 (${SELF.insurer}|${SELF.insured}) と 第1表 2 件は触っていません`);
  if (!EXECUTE) { console.log("\n(--execute で反映)"); return; }
  writeFileSync(BACKUP, JSON.stringify(backup, null, 2), "utf8");
  console.log(`変更前の値を ${path.basename(BACKUP)} に保存しました`);
}

main().catch((e) => { console.error(e); process.exit(1); });
