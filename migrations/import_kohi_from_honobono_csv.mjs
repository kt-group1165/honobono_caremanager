// ============================================================================
// ほのぼの NEXT【利用者管理】→ CSV「公費」を client_insurance_records に取り込む。
//
//   利用者データ/全社_R8-08/公費1.CSV  16列
//     0 利用者番号 / 1 利用者名 / 3 負担者番号 / 4 受給者番号
//     6 有効期限-開始日 / 7 有効期限-終了日 / 8 生活保護区分 / 9 給付割合
//     14 介護医療区分 / 15 本人支払額
//
// ── なぜ要るか ────────────────────────────────────────────────────────
//   2026-08-30 時点で **公費が 1 件も入っていなかった** (0/6,842)。
//   法別12(生活保護) の利用者は保険給付分の残りが公費負担になるので、
//   入っていないと利用者負担を過大に請求する。
//
//   法別は **負担者番号の上 2 桁**。12=生活保護 / 81=特定疾患 / 15=自立支援 等。
//   介護保険の請求に乗るのは介護医療区分が「介護」の行だけ。
//
// ── 突合キー ──────────────────────────────────────────────────────────
//   利用者番号 → clients.user_number。無ければ 氏名+生年月日。
//   公費は **対象月に有効なもの 1 件**を認定レコードに載せる。
//
//   node migrations/import_kohi_from_honobono_csv.mjs            # DRY RUN
//   node migrations/import_kohi_from_honobono_csv.mjs --execute
//   env: MONTH=2026-06
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";

const EXECUTE = process.argv.includes("--execute");
const MONTH = process.env.MONTH || "2026-06";
const MONTH_START = `${MONTH}-01`;
const MONTH_END = new Date(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5, 7)), 0)
  .toISOString().slice(0, 10);
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
  console.log(`=== 公費取込 ${MONTH} ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const K = { no: 0, name: 1, futan: 3, jukyu: 4, from: 6, to: 7, seiho: 8,
    rate: 9, kubun: 14, honnin: 15 };
  const csv = readCsv("公費1.CSV");
  console.log(`  公費 ${csv.rows.length} 行`);

  // 対象月に有効なものだけ
  const byNo = new Map();
  let outOfMonth = 0, notKaigo = 0;
  for (const r of csv.rows) {
    if (r.length <= K.honnin) continue;
    if (r[K.kubun] && r[K.kubun] !== "介護") { notKaigo++; continue; }
    const from = iso(r[K.from]), to = iso(r[K.to]);
    if (!from) continue;
    if (from > MONTH_END || (to && to < MONTH_START)) { outOfMonth++; continue; }
    const cur = byNo.get(r[K.no]);
    if (!cur || from > cur.from) {
      byNo.set(r[K.no], { no: r[K.no], name: r[K.name], futan: r[K.futan],
        jukyu: r[K.jukyu], from, to, honnin: r[K.honnin] });
    }
  }
  console.log(`  ${MONTH} に有効な介護の公費 ${byNo.size} 名` +
    ` (期間外 ${outOfMonth} / 介護以外 ${notKaigo})`);

  const hobetsu = {};
  for (const v of byNo.values()) {
    const h = (v.futan ?? "").slice(0, 2);
    hobetsu[h] = (hobetsu[h] ?? 0) + 1;
  }
  console.log(`  法別: ${Object.entries(hobetsu).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`).join(" / ")}\n`);

  const clients = await fetchAll("clients", "id, user_number, name");
  const byNum = new Map();
  for (const c of clients) if (c.user_number) byNum.set(String(c.user_number), c);

  const ins = await fetchAll("client_insurance_records",
    "id, client_id, kohi_hobetsu, kohi_futansha_number, kohi_jukyusha_number," +
    " kohi_start_date, kohi_end_date, certification_start_date, certification_end_date");
  const insByClient = new Map();
  for (const r of ins) {
    if (!insByClient.has(r.client_id)) insByClient.set(r.client_id, []);
    insByClient.get(r.client_id).push(r);
  }

  const updates = [], noClient = [], noCert = [];
  for (const v of byNo.values()) {
    const c = byNum.get(String(v.no));
    if (!c) { noClient.push(v); continue; }
    const rows = insByClient.get(c.id) ?? [];
    // 対象月に有効な認定レコードに載せる
    const live = rows.filter((r) =>
      (r.certification_start_date ?? "9999") <= MONTH_END &&
      (r.certification_end_date ?? "9999") >= MONTH_START);
    const targets = live.length ? live : rows;
    if (!targets.length) { noCert.push(v); continue; }
    const h = (v.futan ?? "").slice(0, 2);
    for (const t of targets) {
      if (t.kohi_futansha_number === v.futan && t.kohi_jukyusha_number === v.jukyu) continue;
      updates.push({ id: t.id, name: c.name, patch: {
        kohi_hobetsu: h || null,
        kohi_futansha_number: v.futan || null,
        kohi_jukyusha_number: v.jukyu || null,
        kohi_start_date: v.from,
        kohi_end_date: v.to,
      } });
    }
  }

  console.log(`  公費を載せる認定レコード ${updates.length} 件`);
  console.log(`  当方に居ない ${noClient.length} 名 / 認定レコードが無い ${noCert.length} 名`);
  for (const u of updates.slice(0, 15)) {
    console.log(`     ${u.name.padEnd(14)} 法別${u.patch.kohi_hobetsu} ` +
      `${u.patch.kohi_futansha_number}-${u.patch.kohi_jukyusha_number} ` +
      `${u.patch.kohi_start_date}〜${u.patch.kohi_end_date ?? ""}`);
  }
  if (updates.length > 15) console.log(`     … 他 ${updates.length - 15} 件`);

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で反映します。"); return; }

  let n = 0;
  for (const u of updates) {
    const { error } = await sb.from("client_insurance_records")
      .update({ ...u.patch, updated_at: new Date().toISOString() }).eq("id", u.id);
    if (error) { console.error(`✗ ${u.name}: ${error.message}`); process.exit(1); }
    n++;
    if (n % 200 === 0) console.log(`  … ${n}/${updates.length}`);
  }
  console.log(`\n✓ ${n} 件に公費を設定しました`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
