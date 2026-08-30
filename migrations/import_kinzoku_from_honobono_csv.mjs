// ============================================================================
// ほのぼの NEXT【利用者管理】→ CSV「親族関係」から緊急連絡先を取り込む。
//
//   利用者データ/全社_R8-08/親族関係1.CSV  58列
//     0 利用者番号 / 3 利用者名 / 11 生年月日
//     24 親族・関係者名 / 30 続柄 / 37 電話番号(親族) / 38 携帯番号(親族)
//     39 緊急時連絡先 / 40 同居 / 45 主介護者 / 42 優先順
//
// ── 何をするか ────────────────────────────────────────────────────────
//   clients.emergency_contact_name / emergency_contact_phone を埋める。
//   ⚠ **既に入っている欄は上書きしない**。
//
//   優先順位: ① 緊急時連絡先フラグ=1 → ② 主介護者フラグ=1 → ③ 優先順が小さい
//
// ── 突合キー ──────────────────────────────────────────────────────────
//   利用者番号 (介護側 CSV は clients.user_number と対応する)。
//   ⚠ 一致しない場合に **氏名+生年月日**で拾い直す。
//
//   node migrations/import_kinzoku_from_honobono_csv.mjs            # DRY RUN
//   node migrations/import_kinzoku_from_honobono_csv.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";

const EXECUTE = process.argv.includes("--execute");
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
const normName = (s) => (s ?? "").normalize("NFKC").replace(/[\s　]/g, "")
  .replace(/[（(].*?[）)]/g, "");
/** 利用者でない登録 (職員のスケジュール用「★ 会議」等) */
const isDummy = (name) =>
  /^[★◆◎●■☆〇○◇▲△▼▽※＊*]/.test((name ?? "").trim()) || /テスト/.test(name ?? "");

async function fetchAll(table, select) {
  let out = [], from = 0;
  for (;;) {
    const { data, error } = await sb.from(table).select(select).range(from, from + 999);
    if (error) { console.error(`✗ ${table}: ${error.message}`); process.exit(1); }
    out = out.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

async function main() {
  console.log(`=== 親族関係 → 緊急連絡先 取込 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const K = { no: 0, name: 3, birth: 11, kName: 24, zoku: 30, tel: 37, mobile: 38,
    kinkyu: 39, doukyo: 40, priority: 42, shukaigo: 45 };
  const csv = readCsv("親族関係1.CSV");
  console.log(`  親族関係 ${csv.rows.length} 行`);

  // 利用者ごとに最良の 1 件を選ぶ
  const best = new Map();
  let dummies = 0;
  for (const r of csv.rows) {
    if (r.length <= K.shukaigo) continue;
    if (isDummy(r[K.name])) { dummies++; continue; }
    const kName = r[K.kName];
    const tel = r[K.tel] || r[K.mobile];
    if (!kName || !tel) continue;                       // 名前と電話が揃うものだけ
    const score = (r[K.kinkyu] === "1" ? 100 : 0) + (r[K.shukaigo] === "1" ? 50 : 0)
      - (Number(r[K.priority] || 9) || 9);
    const key = r[K.no] || `${normName(r[K.name])}|${iso(r[K.birth])}`;
    const cur = best.get(key);
    if (!cur || score > cur.score) {
      best.set(key, { score, no: r[K.no], name: r[K.name], birth: iso(r[K.birth]),
        kName, zoku: r[K.zoku], tel });
    }
  }
  console.log(`  緊急連絡先を持つ利用者 ${best.size} 名 (ダミー登録 ${dummies} 行を除外)\n`);

  const clients = await fetchAll("clients",
    "id, user_number, name, birth_date, emergency_contact_name, emergency_contact_phone");
  const byNum = new Map();
  const byNB = new Map();
  for (const c of clients) {
    if (c.user_number) byNum.set(String(c.user_number), c);
    if (c.birth_date) {
      const k = `${normName(c.name)}|${c.birth_date}`;
      if (!byNB.has(k)) byNB.set(k, []);
      byNB.get(k).push(c);
    }
  }

  const fills = [], noClient = [];
  for (const b of best.values()) {
    let c = b.no ? byNum.get(String(b.no)) : null;
    if (!c && b.birth) {
      const cands = byNB.get(`${normName(b.name)}|${b.birth}`) ?? [];
      if (cands.length === 1) c = cands[0];
    }
    if (!c) { noClient.push(b); continue; }
    const patch = {};
    const label = b.zoku ? `${b.kName} (${b.zoku})` : b.kName;
    if (!c.emergency_contact_name) patch.emergency_contact_name = label;
    if (!c.emergency_contact_phone) patch.emergency_contact_phone = b.tel;
    if (Object.keys(patch).length) fills.push({ id: c.id, name: c.name, patch });
  }

  console.log(`  緊急連絡先を補える ${fills.length} 名 / 当方に居ない ${noClient.length} 名`);
  for (const f of fills.slice(0, 15)) {
    console.log(`     ${f.name.padEnd(14)} ${f.patch.emergency_contact_name ?? ""} ` +
      `${f.patch.emergency_contact_phone ?? ""}`);
  }
  if (fills.length > 15) console.log(`     … 他 ${fills.length - 15} 名`);

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で反映します。"); return; }

  let n = 0;
  for (const f of fills) {
    const { error } = await sb.from("clients")
      .update({ ...f.patch, updated_at: new Date().toISOString() }).eq("id", f.id);
    if (error) { console.error(`✗ ${f.name}: ${error.message}`); process.exit(1); }
    n++;
    if (n % 200 === 0) console.log(`  … ${n}/${fills.length}`);
  }
  console.log(`\n✓ ${n} 名の緊急連絡先を補完しました`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
