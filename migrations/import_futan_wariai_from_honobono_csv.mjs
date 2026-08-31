// ============================================================================
// ほのぼの【利用者管理】→ CSV「負担割合証等」を取り込んで負担割合を是正する。
//
//   ほのぼのから出力/負担割合証等1.CSV  12列
//     0 利用者名 / 1 被保険者番号 / 2 保険者(名称) / 3 保険有効開始日 / 4 保険有効終了日
//     5 適用 / 6 給付種類 / 7 給付率 / 8 有効開始日 / 9 有効終了日 / 10 制限内容 / 11 備考
//
//   給付率 90 = 1割負担 / 80 = 2割 / 70 = 3割。
//   負担割合証は毎年 8/1〜翌7/31 で切り替わるので **対象月に有効な行**を採る。
//   給付種類は 介護保険負担割合証 / 給付制限 / 特例措置 の 3 種。
//   給付制限・特例措置は負担割合ではないので copay_rate には反映しない。
//
// ── キー ──────────────────────────────────────────────────────────────
//   この CSV は 保険者を **名称** でしか持たない。介護保険1.CSV が
//   (保険者名 → 保険者番号) を持っているので、そこから引いて
//   (保険者番号, 被保険者番号) で当方と突合する。
//   ⚠ 被保険者番号は保険者の中でしか一意でない。番号だけで引いてはいけない。
//
//   node migrations/import_futan_wariai_from_honobono_csv.mjs            # DRY RUN
//   node migrations/import_futan_wariai_from_honobono_csv.mjs --execute
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
const SRC = "C:/Users/domen-PC/Box/10F内共有/ほのぼのから出力";

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
/** 給付率(90/80/70) → 負担割合(1/2/3) */
const rateToCopay = (r) => {
  const n = Number(r);
  if (n === 90) return 1;
  if (n === 80) return 2;
  if (n === 70) return 3;
  return null;      // 0 / 100 / 91 など負担割合証以外の値
};

async function main() {
  console.log(`=== 負担割合取込 ${MONTH} ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  // 介護保険1.CSV から (保険者名 → 保険者番号)
  const hoken = readCsv("介護保険1.CSV");
  const H = { insurerName: 20, insurerNo: 39 };
  const insurerNo = new Map();
  const ambiguous = new Set();
  for (const r of hoken.rows) {
    if (r.length <= H.insurerNo) continue;
    const name = r[H.insurerName], no = r[H.insurerNo];
    if (!name || !no) continue;
    const cur = insurerNo.get(name);
    if (cur && cur !== no) ambiguous.add(name);
    insurerNo.set(name, no);
  }
  console.log(`  保険者名 → 番号 ${insurerNo.size} 件` +
    (ambiguous.size ? ` (名称が複数番号に対応: ${[...ambiguous].join(", ")})` : ""));

  // 負担割合証等
  const F = { name: 0, insured: 1, insurer: 2, kind: 6, rate: 7, from: 8, to: 9, limit: 10 };
  const futan = readCsv("負担割合証等1.CSV");
  const byKey = new Map();
  let noInsurer = 0, outOfMonth = 0;
  for (const r of futan.rows) {
    if (r.length <= F.limit) continue;
    if (r[F.kind] !== "介護保険負担割合証") continue;
    const from = iso(r[F.from]), to = iso(r[F.to]);
    if (!from) continue;
    if (from > MONTH_END || (to && to < MONTH_START)) { outOfMonth++; continue; }
    const no = insurerNo.get(r[F.insurer]);
    if (!no) { noInsurer++; continue; }
    const key = `${no}|${r[F.insured]}`;
    const cur = byKey.get(key);
    if (!cur || from > cur.from) {
      byKey.set(key, { name: r[F.name], from, to, rate: r[F.rate], limit: r[F.limit] });
    }
  }
  console.log(`  ${MONTH} に有効な負担割合証 ${byKey.size} 名` +
    ` (期間外 ${outOfMonth} / 保険者名を解決できず ${noInsurer})\n`);

  // 当方
  let mineRows = [], from = 0;
  for (;;) {
    const { data, error } = await sb.from("client_insurance_records")
      .select("id, client_id, insurer_number, insured_number, copay_rate, benefit_rate," +
        " benefit_period_start, benefit_period_end, certification_start_date," +
        " certification_end_date, clients(name)")
      .order("id").range(from, from + 999);
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    mineRows = mineRows.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  const mine = new Map();
  for (const r of mineRows) {
    if (!r.insurer_number || !r.insured_number) continue;
    const k = `${r.insurer_number}|${r.insured_number}`;
    if (!mine.has(k)) mine.set(k, []);
    mine.get(k).push(r);
  }

  const fix = [], onlyHono = [];
  for (const [key, f] of byKey) {
    const rows = mine.get(key);
    if (!rows) { onlyHono.push({ key, f }); continue; }
    const ids = [...new Set(rows.map((x) => x.client_id))];
    if (ids.length > 1) continue;                     // 重複利用者は触らない
    const copay = rateToCopay(f.rate);
    if (copay == null) continue;
    // 対象月に有効な認定レコードだけに載せる (無ければ全件が対象)
    const inMonth = rows.filter((r) =>
      (r.certification_start_date ?? "9999-12-31") <= MONTH_END &&
      (r.certification_end_date ?? "9999-12-31") >= MONTH_START);
    for (const r of (inMonth.length ? inMonth : rows)) {
      const d = [];
      if (Number(r.copay_rate) !== copay) d.push(`負担割合: ${r.copay_rate} → ${copay}`);
      if (Number(r.benefit_rate) !== Number(f.rate)) d.push(`給付率: ${r.benefit_rate} → ${f.rate}`);
      if ((r.benefit_period_start ?? "") !== f.from) d.push(`証開始: ${r.benefit_period_start} → ${f.from}`);
      if ((r.benefit_period_end ?? "") !== (f.to ?? "")) d.push(`証終了: ${r.benefit_period_end} → ${f.to}`);
      if (d.length) fix.push({ id: r.id, name: r.clients?.name ?? f.name, key, d, copay, f });
    }
  }

  const copayChanges = fix.filter((x) => x.d.some((y) => y.startsWith("負担割合")));
  console.log(`  是正対象 ${fix.length} 件 (うち負担割合そのものが変わる ${copayChanges.length} 件)`);
  for (const x of copayChanges.slice(0, 30)) {
    console.log(`     ${x.name.padEnd(14)} [${x.key}]  ${x.d.filter((y) => y.startsWith("負担割合"))[0]}`);
  }
  if (copayChanges.length > 30) console.log(`     … 他 ${copayChanges.length - 30} 件`);
  console.log(`\n  ほのぼのにあり当方に無い ${onlyHono.length} 名`);

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で反映します。"); return; }

  let n = 0;
  for (const x of fix) {
    const { error } = await sb.from("client_insurance_records").update({
      copay_rate: x.copay,
      benefit_rate: Number(x.f.rate),
      benefit_type: "介護保険負担割合証",
      benefit_content: x.f.limit || null,
      benefit_period_start: x.f.from,
      benefit_period_end: x.f.to,
      updated_at: new Date().toISOString(),
    }).eq("id", x.id);
    if (error) { console.error(`✗ ${x.name}: ${error.message}`); process.exit(1); }
    n++;
  }
  console.log(`\n✓ ${n} 件を反映しました`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
