// ============================================================================
// ほのぼの more【障がい福祉利用者管理】→ CSV から障害の利用者プロフィールと
// 事業所への利用登録を取り込む。
//
//   利用者データ/全社_R8-08/障害_基本情報.CSV   17列 (SRD01「住所」)
//   利用者データ/全社_R8-08/障害_利用登録.CSV   36列 (SRD20)
//
// ── 何をするか ────────────────────────────────────────────────────────
//   ① clients の空欄を埋める (フリガナ / 性別 / 郵便番号 / 住所 / 電話)
//      ⚠ **既に値が入っている欄は上書きしない**。介護側 CSV と食い違う可能性があり、
//        どちらが新しいか CSV からは判断できないため。
//   ② client_office_assignments を利用登録から補う
//      これが無いと UI の「自事業所」タブに出ず、集計からも漏れる。
//
// ── 突合キー ──────────────────────────────────────────────────────────
//   **氏名(正規化) + 生年月日**。利用者番号は使わない。
//   (memory: 短番号が事業所エントリ番号と衝突する / import_honobono_shougai_oami.mjs と同じ規約)
//
//   node migrations/import_shougai_clients_from_honobono_csv.mjs            # DRY RUN
//   node migrations/import_shougai_clients_from_honobono_csv.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";

const EXECUTE = process.argv.includes("--execute");
const TENANT = "kt-group";
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const SRC = path.join(KAIGO, "利用者データ/全社_R8-08");

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

const splitCsv = (line) => {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
};
const readCsv = (file) => {
  const p = path.join(SRC, file);
  if (!existsSync(p)) { console.error(`✗ ${p} がありません`); process.exit(1); }
  const rows = iconv.decode(readFileSync(p), "Shift_JIS")
    .split(/\r?\n/).filter((l) => l.trim()).map((l) => splitCsv(l).map((s) => s.trim()));
  return { head: rows[0], rows: rows.slice(1) };
};
const iso = (s) => {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((s ?? "").trim());
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
};
/** 氏名の正規化。全角/半角スペース・記号ゆれを吸収する */
const normName = (s) => (s ?? "").normalize("NFKC").replace(/[\s　]/g, "")
  .replace(/[（(].*?[）)]/g, "");
const isDummy = (name) =>
  /テスト/.test(name ?? "") || /^[★◆◎●■☆〇○◇▲△▼▽※＊*]/.test((name ?? "").trim());

async function fetchAll(table, select, tweak) {
  let out = [], from = 0;
  for (;;) {
    let q = sb.from(table).select(select).order("id").order("id").range(from, from + 999);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) { console.error(`✗ ${table}: ${error.message}`); process.exit(1); }
    out = out.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

async function main() {
  console.log(`=== 障害 利用者プロフィール・利用登録 取込 ` +
    `${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const base = readCsv("障害_基本情報.CSV");
  const touroku = readCsv("障害_利用登録.CSV");
  const B = { no: 0, name: 1, kana: 2, birth: 3, sex: 4, zip: 7, addr: 8, tel: 9, mobile: 11 };
  const T = { no: 0, name: 1, birth: 3, office: 17, from: 18, to: 23 };

  const profiles = new Map();      // 氏名|生年月日 → プロフィール
  let dummies = 0;
  for (const r of base.rows) {
    if (r.length <= B.mobile) continue;
    if (isDummy(r[B.name])) { dummies++; continue; }
    const birth = iso(r[B.birth]);
    if (!birth) continue;
    profiles.set(`${normName(r[B.name])}|${birth}`, {
      name: r[B.name], furigana: r[B.kana] || null, gender: r[B.sex] || null,
      postal_code: r[B.zip] || null, address: r[B.addr] || null,
      phone: r[B.tel] || r[B.mobile] || null,
    });
  }
  console.log(`  基本情報 ${profiles.size} 名 (テスト登録 ${dummies} 件を除外)`);

  // 当方の利用者
  const clients = await fetchAll("clients",
    "id, name, birth_date, furigana, gender, postal_code, address, phone, tenant_id");
  const byNB = new Map();
  for (const c of clients) {
    if (!c.birth_date) continue;
    const k = `${normName(c.name)}|${c.birth_date}`;
    if (!byNB.has(k)) byNB.set(k, []);
    byNB.get(k).push(c);
  }
  console.log(`  当方の利用者 ${clients.length} 名\n`);

  // ① プロフィールの空欄を埋める
  const fills = [], noClient = [], dupClient = [];
  for (const [k, p] of profiles) {
    const cands = byNB.get(k);
    if (!cands) { noClient.push(p); continue; }
    if (cands.length > 1) { dupClient.push({ p, n: cands.length }); continue; }
    const c = cands[0];
    const patch = {};
    for (const col of ["furigana", "gender", "postal_code", "address", "phone"]) {
      // ⚠ 既に入っている欄は触らない
      if (!c[col] && p[col]) patch[col] = p[col];
    }
    if (Object.keys(patch).length) fills.push({ id: c.id, name: c.name, patch });
  }
  console.log(`  プロフィールを補える ${fills.length} 名`);
  const cnt = {};
  for (const f of fills) for (const k of Object.keys(f.patch)) cnt[k] = (cnt[k] ?? 0) + 1;
  console.log(`     内訳: ${Object.entries(cnt).map(([k, v]) => `${k} ${v}`).join(" / ")}`);
  console.log(`  当方に居ない ${noClient.length} 名 / 同名同生年月日が複数 ${dupClient.length} 名`);

  // ② 利用登録 → client_office_assignments
  const offices = await fetchAll("offices", "id, name, shogai_business_number");
  const offByName = new Map();
  for (const o of offices) offByName.set(normName(o.name), o.id);

  /**
   * ほのぼの(more)の事業者名は **法人名の前置き + サービス種別の後置き**が付く。
   *   「株式会社ケィ・ティ・サービス　ＫＴ姉崎ヘルパーステーション」
   *   「Hanaﾍﾙﾊﾟｰｽﾃｰｼｮﾝおゆみ野【身障居宅】」
   *   「※ＫＴ五井ヘルパーステーション」
   * そのままだと当方の事業所名と一致しないので、地名トークンで寄せる。
   */
  const AREA_TOKENS = ["おゆみ野", "さつきが丘", "ちはら台", "四街道", "花見川", "高品",
    "八千代", "船橋", "やわた", "五井", "姉崎", "大網白里", "山武", "東郷", "いすみ",
    "木更津", "袖ヶ浦", "袖ケ浦", "市原", "君津", "中央", "茂原"];
  const areaOf = (s) => {
    const t = (s ?? "").normalize("NFKC").replace(/[\s　]/g, "");
    for (const a of AREA_TOKENS) if (t.includes(a.normalize("NFKC"))) return a;
    return null;
  };
  /** 当方の訪問介護事業所を 地名 → id で引けるようにする (障害事業所番号を持つものを優先) */
  const offByArea = new Map();
  for (const o of offices) {
    if (!/ヘルパー|ヘルパ/.test(o.name)) continue;
    const a = areaOf(o.name);
    if (!a) continue;
    const cur = offByArea.get(a);
    if (!cur || (!cur.shogai_business_number && o.shogai_business_number)) {
      offByArea.set(a, o);
    }
  }
  const resolveOffice = (honoName) => {
    const direct = offByName.get(normName(honoName));
    if (direct) return direct;
    // 「ムツミヘルパーステーション」だけは地名が無く 姉ム を指す
    const a = areaOf(honoName);
    if (a) return offByArea.get(a)?.id ?? null;
    if (/ムツミヘルパー/.test((honoName ?? "").normalize("NFKC"))) {
      return offByName.get(normName("ムツミヘルパーステーション")) ?? null;
    }
    return null;
  };
  const assigns = await fetchAll("client_office_assignments", "client_id, office_id");
  const haveAssign = new Set(assigns.map((a) => `${a.client_id}|${a.office_id}`));

  const newAssign = [], unknownOffice = new Map();
  for (const r of touroku.rows) {
    if (r.length <= T.to) continue;
    if (isDummy(r[T.name])) continue;
    const birth = iso(r[T.birth]);
    if (!birth) continue;
    // 終了している登録は割当を作らない
    const to = iso(r[T.to]);
    if (to && to < "2026-06-01") continue;
    const cands = byNB.get(`${normName(r[T.name])}|${birth}`);
    if (!cands || cands.length !== 1) continue;
    const offId = resolveOffice(r[T.office]);
    if (!offId) {
      unknownOffice.set(r[T.office], (unknownOffice.get(r[T.office]) ?? 0) + 1);
      continue;
    }
    const key = `${cands[0].id}|${offId}`;
    if (haveAssign.has(key)) continue;
    haveAssign.add(key);
    newAssign.push({ tenant_id: TENANT, client_id: cands[0].id, office_id: offId });
  }
  console.log(`\n  追加する事業所割当 ${newAssign.length} 件`);
  if (unknownOffice.size) {
    console.log(`  ⚠ 事業所名を解決できない ${unknownOffice.size} 種:`);
    for (const [k, v] of [...unknownOffice].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`     ${String(v).padStart(4)}  ${k}`);
    }
  }

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で反映します。"); return; }

  let n = 0;
  for (const f of fills) {
    const { error } = await sb.from("clients")
      .update({ ...f.patch, updated_at: new Date().toISOString() }).eq("id", f.id);
    if (error) { console.error(`✗ ${f.name}: ${error.message}`); process.exit(1); }
    n++;
  }
  console.log(`✓ ${n} 名のプロフィールを補完`);

  let m = 0;
  for (let i = 0; i < newAssign.length; i += 200) {
    const chunk = newAssign.slice(i, i + 200);
    const { error } = await sb.from("client_office_assignments").insert(chunk);
    if (error) { console.error(`✗ 割当: ${error.message}`); process.exit(1); }
    m += chunk.length;
  }
  console.log(`✓ ${m} 件の事業所割当を追加`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
