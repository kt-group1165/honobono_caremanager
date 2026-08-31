// ============================================================================
// 別人に付いてしまった認定・レセプトを、正しい持ち主に戻す。
//
//   node migrations/fix_cert_owner_mismatch.mjs             # DRY RUN
//   node migrations/fix_cert_owner_mismatch.mjs --execute
//
//   検出は check_cert_owner_mismatch.mjs と同じ判定を使う。
//   まず検査を回して中身を確かめてから、これを流すこと。
//
// ── なぜ起きるか ────────────────────────────────────────────────────────
//   取込が **利用者番号** や **被保険者番号だけ** で利用者を引き当てているため。
//   どちらも 1 人を指さない。
//     ・利用者番号  未採番は 2147483647。それ以外も使い回される
//     ・被保険者番号 保険者の中でしか一意でない
//   実例 (2026-08-31):
//     秋元 とし子 (122069|0000036608) に 今井 義春 (**124271**|0000036608) の認定
//       → 被保番が同じで保険者だけ違う。番号だけで引くと必ず当たる
//     天野 昭代 (121061|1003814660) に 原田 智子 (121012|1004788053) の認定
//
// ── やること ────────────────────────────────────────────────────────────
//   利用者マスタ CSV の (保険者, 被保番) → 氏名 を正として、
//     ・持ち主の client が無ければ CSV から作る
//     ・認定とレセプトを持ち主へ付け替える
//     ・CSV の支援事業所が当社の居宅なら事業所割当も作る
//   受け皿側の本人の分は触らない。
//
// ── 安全策 ──────────────────────────────────────────────────────────────
//   ・CSV で氏名が確定できないものは触らない
//   ・作る前に (保険者,被保番) と 氏名+生年月日 の両方で既存を探す
//     (番号が null の既存 client を見落として二重作成した前例がある)
//   ・変更前の値を migrations/_cert_owner_fix_backup.json に残す
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const TENANT = "kt-group";
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const BACKUP = path.join(KAIGO, "migrations/_cert_owner_fix_backup.json");

const env = {};
for (const l of readFileSync(path.join(KAIGO, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

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
const VARIANTS = {
  "髙": "高", "﨑": "崎", "齋": "斎", "齊": "斉", "濵": "浜", "邉": "辺", "邊": "辺",
  "冨": "富", "廣": "広", "德": "徳", "惠": "恵", "愼": "慎", "淸": "清", "眞": "真",
  "瀨": "瀬", "栁": "柳", "槗": "橋", "曻": "昇",
};
/** 氏名の正規化。check_cert_owner_mismatch.mjs と同じ規則にすること */
function normNm(s) {
  return (s ?? "").normalize("NFKC")
    .replace(/[（(][^）)]*[）)]?\s*$/g, "")
    .replace(/[\s　()（）]/g, "")
    .replace(/[髙﨑齋齊濵邉邊冨廣德惠愼淸眞瀨栁槗曻]/g, (c) => VARIANTS[c] ?? c);
}
const iso = (s) => { const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((s ?? "").trim()); return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null; };
const careLevel = (s) => (s ?? "").trim().normalize("NFKC").replace(/^要介護度/, "要介護").replace(/^要支援度/, "要支援");

async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** 介護保険CSV / 基本情報CSV を集めて索引する */
function loadCsv() {
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
  const read = (f) => {
    const L = sjis.decode(readFileSync(f)).split(/\r?\n/).filter((x) => x !== "");
    if (!L.length) return { idx: {}, rows: [] };
    const h = parseLine(L[0]).map((x) => x.trim());
    const idx = {}; h.forEach((x, i) => { if (!(x in idx)) idx[x] = i; });
    return { idx, rows: L.slice(1).map(parseLine) };
  };
  const g = (r, idx, k) => (idx[k] != null && idx[k] < r.length ? (r[idx[k]] ?? "").trim() || null : null);

  const certByPair = new Map();     // 保険者|被保番 -> 認定行 (対象月に近い順は問わない)
  for (const f of kaigo) {
    const { idx, rows } = read(f);
    if (!("被保険者番号" in idx) || !("保険者番号" in idx)) continue;
    for (const r of rows) {
      const k = `${g(r, idx, "保険者番号")}|${g(r, idx, "被保険者番号")}`;
      if (!certByPair.has(k)) certByPair.set(k, []);
      certByPair.get(k).push({ idx, r, g });
    }
  }
  const kihonByName = new Map();    // 正規化氏名 -> 基本情報行
  for (const f of kihon) {
    const { idx, rows } = read(f);
    if (!("利用者名" in idx)) continue;
    for (const r of rows) {
      const nm = normNm(g(r, idx, "利用者名"));
      if (nm && !kihonByName.has(nm)) kihonByName.set(nm, { idx, r, g });
    }
  }
  return { certByPair, kihonByName, fileCount: kaigo.length + kihon.length };
}

async function main() {
  console.log(`=== 別人に付いた認定・レセプトを持ち主へ戻す ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);
  const { certByPair, kihonByName, fileCount } = loadCsv();
  console.log(`利用者マスタ CSV ${fileCount} 本\n`);

  const clients = (await fetchAll(() => sb.from("clients")
    .select("id, name, user_number, birth_date, insurer_number, insured_number, deleted_at")))
    .filter((c) => !c.deleted_at);
  const byId = new Map(clients.map((c) => [c.id, c]));
  const byPair = new Map(), byNameBirth = new Map();
  for (const c of clients) {
    if (c.insurer_number && c.insured_number) byPair.set(`${c.insurer_number}|${c.insured_number}`, c);
    if (c.birth_date) byNameBirth.set(`${normNm(c.name)}|${c.birth_date}`, c);
  }
  const certs = await fetchAll(() => sb.from("client_insurance_records")
    .select("id, client_id, insurer_number, insured_number, care_level, certification_start_date, certification_end_date, notes"));
  const { data: offices } = await sb.from("offices").select("id, name").eq("service_type", "居宅介護支援");
  const officeByName = new Map((offices ?? []).map((o) => [o.name.normalize("NFKC").replace(/[\s　]/g, ""), o]));

  const plan = [], skip = [];
  for (const r of certs) {
    const host = byId.get(r.client_id);
    if (!host || !r.insurer_number || !r.insured_number) continue;
    const key = `${r.insurer_number}|${r.insured_number}`;
    const rows = certByPair.get(key);
    if (!rows?.length) continue;
    const ownerName = rows.map((x) => x.g(x.r, x.idx, "利用者名")).find(Boolean);
    if (!ownerName || normNm(ownerName) === normNm(host.name)) continue;

    const kh = kihonByName.get(normNm(ownerName));
    const birth = kh ? iso(kh.g(kh.r, kh.idx, "生年月日")) : null;
    let owner = byPair.get(key) ?? (birth ? byNameBirth.get(`${normNm(ownerName)}|${birth}`) : null);
    if (owner && owner.id === host.id) { skip.push(`${host.name}: 自分自身に当たる (異常)`); continue; }

    const { data: claims } = await sb.from("kaigo_care_support_claims")
      .select("id, billing_month, total_amount")
      .eq("user_id", host.id).eq("insurer_number", r.insurer_number).eq("insured_number", r.insured_number);
    const src = rows[0];
    const supportOffice = src.g(src.r, src.idx, "支援事業所（正式名称）") ?? src.g(src.r, src.idx, "支援事業所");
    const office = supportOffice ? officeByName.get(supportOffice.normalize("NFKC").replace(/[\s　]/g, "")) : null;

    plan.push({ host, cert: r, key, ownerName, birth, owner, kh, claims: claims ?? [], office, src });
  }

  console.log(`― 戻す ${plan.length} 件 ―`);
  for (const p of plan) {
    console.log(`   当方「${p.host.name}」(利番${p.host.user_number}) の ${p.key} ${p.cert.care_level ?? ""}`);
    console.log(`      → 「${p.ownerName}」(生${p.birth ?? "?"}) ${p.owner ? `既存 ${p.owner.id.slice(0, 8)}` : "**新規作成**"}` +
      (p.claims.length ? `  レセプト ${p.claims.map((c) => `${c.billing_month} ${c.total_amount}円`).join(" / ")}` : "") +
      (p.office ? `  割当 ${p.office.name}` : ""));
  }
  const money = plan.flatMap((p) => p.claims).reduce((s, c) => s + (c.total_amount ?? 0), 0);
  if (money) console.log(`   → 戻すレセプト合計 ${money.toLocaleString()} 円`);
  if (skip.length) { console.log("\n― 触らない ―"); for (const s of skip) console.log(`   ${s}`); }

  if (!EXECUTE) { console.log("\n(--execute で反映)"); return; }

  const backup = [];
  let ok = 0, ng = 0;
  for (const p of plan) {
    let ownerId = p.owner?.id ?? null;
    if (!ownerId) {
      const kh = p.kh;
      const cl = careLevel(p.cert.care_level);
      const client = {
        user_number: `${p.key.replace("|", "-")}`, name: p.ownerName, tenant_id: TENANT,
        status: "active", is_provisional: false, birth_date: p.birth,
        furigana: kh ? kh.g(kh.r, kh.idx, "フリガナ") : null,
        gender: kh ? kh.g(kh.r, kh.idx, "性別") : null,
        postal_code: kh ? kh.g(kh.r, kh.idx, "郵便番号") : null,
        address: kh ? kh.g(kh.r, kh.idx, "住所") : null,
        phone: kh ? kh.g(kh.r, kh.idx, "電話番号") : null,
        insurer_number: p.key.split("|")[0], insured_number: p.key.split("|")[1],
        care_level: cl || null,
        certification_start_date: p.cert.certification_start_date,
        certification_end_date: p.cert.certification_end_date,
      };
      const { data: row, error } = await sb.from("clients").insert(client).select("id").single();
      if (error) { console.error(`✗ ${p.ownerName} の作成に失敗: ${error.message}`); ng++; continue; }
      ownerId = row.id;
      backup.push({ action: "created_client", id: ownerId, name: p.ownerName });
      console.log(`  + ${p.ownerName} を作成`);
    }
    backup.push({ action: "move_cert", id: p.cert.id, from: p.host.id, to: ownerId });
    const { error: ce } = await sb.from("client_insurance_records").update({ client_id: ownerId }).eq("id", p.cert.id);
    if (ce) { console.error(`✗ 認定の付け替えに失敗 ${p.ownerName}: ${ce.message}`); ng++; continue; }

    for (const c of p.claims) {
      backup.push({ action: "move_claim", id: c.id, from: p.host.id, to: ownerId });
      const { error } = await sb.from("kaigo_care_support_claims").update({ user_id: ownerId }).eq("id", c.id);
      if (error) console.error(`✗ レセプトの付け替えに失敗 ${c.billing_month}: ${error.message}`);
    }
    if (p.office) {
      const { data: has } = await sb.from("client_office_assignments")
        .select("client_id").eq("client_id", ownerId).eq("office_id", p.office.id).maybeSingle();
      if (!has) {
        const { error } = await sb.from("client_office_assignments").insert({
          tenant_id: TENANT, client_id: ownerId, office_id: p.office.id,
          start_date: p.cert.certification_start_date ?? "2026-06-01", home_care_categories: [],
        });
        if (error) console.error(`✗ 割当の作成に失敗 ${p.ownerName}: ${error.message}`);
      }
    }
    ok++;
  }
  if (backup.length) writeFileSync(BACKUP, JSON.stringify(backup, null, 2), "utf8");
  console.log(`\n戻した ${ok} 件 / 失敗 ${ng} 件`);
  if (backup.length) console.log(`変更前の値を ${path.basename(BACKUP)} に保存しました`);
  console.log("→ check_cert_owner_mismatch.mjs をもう一度回して 0 件になることを確かめること");
}

main().catch((e) => { console.error(e); process.exit(1); });
