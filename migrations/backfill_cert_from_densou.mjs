/**
 * 対象月に有効な認定が DB に無い利用者へ、ほのぼの実伝送から認定行を補完する。
 *
 * 背景 (2026-08-04 の 202606 突合):
 *   更新後の認定 (例 2026-07-01〜) しか取り込まれておらず、202606 時点の認定が
 *   DB に無い利用者がいる。resolveCertForMonth は仕様どおり「最新1件」へ
 *   フォールバックするため、**対象月を含まない認定有効期間で伝送が出る**
 *   (例 阿部 義昭: 新 20260701〜20300630 / ほのぼの 20250701〜20260630)。
 *   国保連では確実に返戻になる。
 *
 * 補完元: 伝送データ配下の「ほのぼのから」CSV の 7131/01・71R1/01 基本情報レコード
 *   項6  = 証記載保険者番号      → insurer_number
 *   項7  = 被保険者番号          → insured_number
 *   項15 = 要介護状態区分コード  → care_level
 *   項17 = 認定有効期間 開始     → certification_start_date
 *   項18 = 認定有効期間 終了     → certification_end_date
 *   項29 = 保険給付率            → copay_rate (90→1 / 80→2 / 70→3)
 *
 * 実行:
 *   node migrations/backfill_cert_from_densou.mjs           # DRY RUN (既定)
 *   node migrations/backfill_cert_from_densou.mjs --execute # 本番
 *   env: MONTH=202606
 *
 * 既存行は書き換えない (INSERT のみ)。--execute 時は挿入した id を
 * _backfill_cert_<MONTH>_<日付>.json に残す (取り消し用)。
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Encoding from "encoding-japanese";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = join(__dirname, "..");
const ROOT = join(APP, "伝送データ");
const MONTH = process.env.MONTH || "202606";
const EXECUTE = process.argv.includes("--execute");

function loadEnvLocal() {
  const raw = readFileSync(join(APP, ".env.local"), "utf8");
  const vars = {};
  for (const line of raw.split("\n")) {
    const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
    if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return vars;
}
const env = loadEnvLocal();
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
function splitCsvLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}
const t = (s) => (s ?? "").trim();
const isoDate = (d) => (/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : null);

// 要介護状態区分コード → 表記 (build.ts の CARE_LEVEL_CODE の逆引き)
const CARE_LEVEL_BY_CODE = {
  "06": "事業対象者", "12": "要支援1", "13": "要支援2",
  "21": "要介護1", "22": "要介護2", "23": "要介護3", "24": "要介護4", "25": "要介護5",
};
const COPAY_BY_RATE = { "90": "1", "80": "2", "70": "3" };

// ─── 1) ほのぼのから (被保番 → 認定) を集める ────────────────────────────────
const truth = new Map();
const files = walk(ROOT).filter(
  (f) => /ほのぼのから/.test(f) && /\.csv$/i.test(f) && f.includes(MONTH),
);
for (const f of files) {
  const text = Encoding.codeToString(
    Encoding.convert(new Uint8Array(readFileSync(f)), { to: "UNICODE", from: "SJIS" }),
  );
  for (const line of text.split(/\r\n|\n/)) {
    if (!line) continue;
    const c = splitCsvLine(line);
    if (c[0] !== "2") continue;
    if (!((c[2] === "7131" || c[2] === "71R1") && c[3] === "01")) continue;
    const insured = t(c[7]);
    if (!insured) continue;
    const start = isoDate(t(c[18]));
    const end = isoDate(t(c[19]));
    if (!start) continue;
    truth.set(insured, {
      insurer: t(c[6]).replace(/^0+/, "") || t(c[6]), // 証記載保険者は 00 詰め 8 桁
      insurerRaw: t(c[6]),
      careLevel: CARE_LEVEL_BY_CODE[t(c[16])] ?? null,
      start, end,
      copay: COPAY_BY_RATE[t(c[30])] ?? null,
      rate: t(c[30]),
      file: f.split("伝送データ")[1].replace(/\\/g, "/"),
    });
  }
}
console.log(`ほのぼの側: ${files.length} ファイル / 被保険者 ${truth.size} 名 (提供年月 ${MONTH})\n`);

// ─── 2) DB を見て「対象月に有効な認定が無い」利用者を絞る ───────────────────
const mStart = `${MONTH.slice(0, 4)}-${MONTH.slice(4)}-01`;
const lastDay = new Date(Number(MONTH.slice(0, 4)), Number(MONTH.slice(4)), 0).getDate();
const mEnd = `${MONTH.slice(0, 4)}-${MONTH.slice(4)}-${lastDay}`;

const insuredList = [...truth.keys()];
const clients = [];
for (let i = 0; i < insuredList.length; i += 100) {
  const { data, error } = await sb
    .from("clients").select("id, name, insured_number, tenant_id")
    .in("insured_number", insuredList.slice(i, i + 100));
  if (error) { console.error("clients 取得失敗:", error.message); process.exit(1); }
  clients.push(...(data ?? []));
}
const byInsured = new Map();
for (const c of clients) {
  if (!byInsured.has(c.insured_number)) byInsured.set(c.insured_number, []);
  byInsured.get(c.insured_number).push(c);
}

const certRows = [];
const clientIds = clients.map((c) => c.id);
for (let i = 0; i < clientIds.length; i += 100) {
  const { data, error } = await sb
    .from("client_insurance_records")
    .select("id, client_id, certification_start_date, certification_end_date, care_level")
    .in("client_id", clientIds.slice(i, i + 100));
  if (error) { console.error("認定取得失敗:", error.message); process.exit(1); }
  certRows.push(...(data ?? []));
}
const certByClient = new Map();
for (const r of certRows) {
  if (!certByClient.has(r.client_id)) certByClient.set(r.client_id, []);
  certByClient.get(r.client_id).push(r);
}

const plan = [], skipped = [], noClient = [];
for (const [insured, hb] of truth) {
  const cs = byInsured.get(insured);
  if (!cs || cs.length === 0) { noClient.push(insured); continue; }
  if (cs.length > 1) { skipped.push(`${insured}: clients ${cs.length}件 (要手当て)`); continue; }
  const c = cs[0];
  const rows = certByClient.get(c.id) ?? [];
  const active = rows.filter(
    (r) => (!r.certification_start_date || r.certification_start_date <= mEnd) &&
           (!r.certification_end_date || r.certification_end_date >= mStart),
  );
  if (active.length > 0) continue; // 対象月に有効な認定がある = 何もしない
  // 同じ期間の行が既にあるなら二重登録しない
  if (rows.some((r) => r.certification_start_date === hb.start)) {
    skipped.push(`${insured} ${c.name}: 同じ開始日の認定が既にある`);
    continue;
  }
  if (!hb.careLevel) { skipped.push(`${insured} ${c.name}: 要介護度コードが読めない`); continue; }
  plan.push({
    insured, name: c.name, clientId: c.id, tenantId: c.tenant_id,
    existing: rows.map((r) => `${r.care_level} ${r.certification_start_date}〜${r.certification_end_date}`),
    row: {
      tenant_id: c.tenant_id,
      client_id: c.id,
      insured_number: insured,
      insurer_number: hb.insurerRaw.replace(/^0+/, ""),
      care_level: hb.careLevel,
      certification_start_date: hb.start,
      certification_end_date: hb.end,
      effective_date: hb.start,
      copay_rate: hb.copay,
      certification_status: "認定済み",
      record_status: "認定済み",
      notes: `[伝送から補完 ${MONTH}]`,
    },
    file: hb.file,
  });
}

// ─── 3) 表示 ─────────────────────────────────────────────────────────────────
console.log(`${EXECUTE ? "🔴 本番実行" : "DRY RUN"} — 補完対象 ${plan.length} 名\n`);
const byArea = {};
for (const p of plan) {
  const a = p.file.split("/")[1];
  (byArea[a] ??= []).push(p);
}
for (const [area, ps] of Object.entries(byArea)) {
  console.log(`--- ${area} (${ps.length}名) ---`);
  for (const p of ps) {
    console.log(`  ${p.insured} ${p.name}: ${p.row.care_level} ${p.row.certification_start_date}〜${p.row.certification_end_date} (負担${p.row.copay_rate}割)`);
    console.log(`      既存: ${p.existing.length ? p.existing.join(" / ") : "(認定行なし)"}`);
  }
}
if (skipped.length) {
  console.log(`\n--- skip ${skipped.length} 件 ---`);
  for (const s of skipped.slice(0, 20)) console.log(`  ${s}`);
  if (skipped.length > 20) console.log(`  … 他 ${skipped.length - 20} 件`);
}
console.log(`\nclients に居ない被保険者番号: ${noClient.length} 件 (未取込拠点の利用者)`);

if (!EXECUTE) {
  console.log("\nDRY RUN — 何も書き込んでいません。--execute で INSERT します。");
  process.exit(0);
}

// ─── 4) 実行 ─────────────────────────────────────────────────────────────────
const inserted = [];
for (const p of plan) {
  const { data, error } = await sb
    .from("client_insurance_records").insert(p.row).select("id").single();
  if (error) { console.error(`  ✗ ${p.insured} ${p.name}: ${error.message}`); continue; }
  inserted.push({ id: data.id, insured: p.insured, name: p.name });
}
const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const outPath = join(__dirname, `_backfill_cert_${MONTH}_${stamp}.json`);
writeFileSync(outPath, JSON.stringify(inserted, null, 1));
console.log(`\n完了: ${inserted.length}/${plan.length} 行 INSERT`);
console.log(`挿入 id: ${outPath} (取り消しはこの id を DELETE)`);
console.log("反映後は伝送突合ハーネスを回し直して差が減ることを確認してください。");
