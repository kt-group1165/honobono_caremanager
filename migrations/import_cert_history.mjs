/**
 * ほのぼの「介護保険」CSV から認定履歴を client_insurance_records へ取り込む。
 *
 * 背景 (2026-08-04 の 202606 突合):
 *   DB に更新後の認定 (例 2026-07-01〜) しか無い利用者が 23 名いて、
 *   resolveCertForMonth が仕様どおり「最新1件」へフォールバックした結果、
 *   202606 の伝送に対象月を含まない認定有効期間・違う要介護度が載っていた。
 *   取込元 CSV には認定履歴が全部入っているのに、最新1件しか DB に入れていなかった。
 *
 * 取込元: 利用者データ/<拠点>/介護保険1.CSV (Shift_JIS)
 *   ヘッダは拠点によって列数が違うので **列名で引く** (位置固定にしない)。
 *   被保険者番号 / 保険者番号 / 要介護度 / 認定有効期間 / 適用期間(居宅ｻｰﾋﾞｽ区分) /
 *   区分支給限度基準額 / 給付率 / 認定状況 / 認定年月日 / 支援事業所 / 担当ケアマネジャー
 *
 * 方針:
 *   - **INSERT のみ**。既存行は書き換えない (同じ client × 認定開始日 があれば skip)。
 *   - 既存行と値が食い違うものは「差分」として報告するだけ (判断は人が行う)。
 *   - 給付率は認定時点の値であって負担割合証ではない。既存行の copay_rate は触らない
 *     (→ docs/AUDIT_densou_202606.md の A 参照)。
 *
 * 実行:
 *   node migrations/import_cert_history.mjs            # DRY RUN (既定)
 *   node migrations/import_cert_history.mjs --execute  # 本番
 *   env: AREA=大網  … 特定拠点だけに絞る (既定 = 利用者データ/ 配下すべて)
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = join(__dirname, "..");
const USER_ROOT = join(APP, "利用者データ");
const EXECUTE = process.argv.includes("--execute");
const ONLY_AREA = process.env.AREA || null;
const MARK = "[認定履歴取込 2026-08-04]";

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

const sjis = new TextDecoder("shift_jis");
function parseLine(line) {
  const o = [];
  let c = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { c += '"'; i++; } else q = false; }
      else c += ch;
    } else {
      if (ch === '"') q = true;
      else if (ch === ",") { o.push(c); c = ""; }
      else c += ch;
    }
  }
  o.push(c);
  return o;
}
const iso = (s) => {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((s ?? "").trim());
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
};
const intOr = (s) => {
  const v = parseInt((s ?? "").replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(v) ? v : null;
};
// 要介護度: CSV は全角数字 (要介護１)。DB は半角 (要介護1)。
const ZEN = { "０": "0", "１": "1", "２": "2", "３": "3", "４": "4", "５": "5" };
const normLevel = (s) => {
  const t = (s ?? "").trim().replace(/[０-５]/g, (c) => ZEN[c]);
  if (!t) return null;
  if (/^要介護[1-5]$/.test(t) || /^要支援[12]$/.test(t) || t === "事業対象者") return t;
  return null; // 経過的要介護 等は DB に対応値が無いので取り込まない
};
// 給付率 → 負担割合 (1/2/3 割)。0・空は不明 = null
const COPAY_BY_RATE = { "90": "1", "80": "2", "70": "3" };

// ─── 1) CSV を読む ───────────────────────────────────────────────────────────
const areas = readdirSync(USER_ROOT).filter(
  (a) => (!ONLY_AREA || a === ONLY_AREA) && existsSync(join(USER_ROOT, a, "介護保険1.CSV")),
);
if (areas.length === 0) { console.error("介護保険1.CSV が見つかりません"); process.exit(1); }

const csvRows = [];
const badLevel = [];
for (const area of areas) {
  const lines = sjis.decode(readFileSync(join(USER_ROOT, area, "介護保険1.CSV")))
    .split(/\r?\n/).filter((l) => l);
  const H = parseLine(lines[0]).map((h) => h.replace(/^"|"$/g, ""));
  const gi = (n) => H.indexOf(n);
  const I = {
    userNo: gi("利用者番号"), name: gi("利用者名"), insured: gi("被保険者番号"),
    insurer: gi("保険者番号"), insurerName: gi("保険者"), rate: gi("給付率"),
    status: gi("認定状況"), level: gi("要介護度"), certDate: gi("認定年月日"),
    certStart: gi("認定有効期間－開始日"), certEnd: gi("認定有効期間－終了日"),
    limStart: gi("適用期間－開始日（居宅ｻｰﾋﾞｽ区分）"), limEnd: gi("適用期間－終了日（居宅ｻｰﾋﾞｽ区分）"),
    limit: gi("区分支給限度基準額（居宅ｻｰﾋﾞｽ区分）"),
    cmName: gi("担当ケアマネジャー"), officeName: gi("支援事業所（正式名称）"),
  };
  if (I.insured < 0 || I.certStart < 0) {
    console.error(`  ⚠ ${area}: 想定の列が無い (被保険者番号/認定有効期間－開始日) — skip`);
    continue;
  }
  for (const l of lines.slice(1)) {
    const c = parseLine(l).map((x) => x.replace(/^"|"$/g, ""));
    const insured = (c[I.insured] ?? "").trim();
    const certStart = iso(c[I.certStart]);
    if (!insured || !certStart) continue;
    const level = normLevel(c[I.level]);
    if (!level) { badLevel.push(`${area} ${c[I.name]} "${(c[I.level] ?? "").trim()}"`); continue; }
    csvRows.push({
      area, insured, userNo: (c[I.userNo] ?? "").trim(), name: (c[I.name] ?? "").trim(),
      insurer: (c[I.insurer] ?? "").trim() || null,
      insurerName: (c[I.insurerName] ?? "").trim() || null,
      level, certStart, certEnd: iso(c[I.certEnd]),
      limStart: I.limStart >= 0 ? iso(c[I.limStart]) : null,
      limEnd: I.limEnd >= 0 ? iso(c[I.limEnd]) : null,
      limit: I.limit >= 0 ? intOr(c[I.limit]) : null,
      rate: (c[I.rate] ?? "").trim(),
      status: (c[I.status] ?? "").trim() || "認定済み",
      certDate: I.certDate >= 0 ? iso(c[I.certDate]) : null,
      cmName: I.cmName >= 0 ? (c[I.cmName] ?? "").trim() || null : null,
      officeName: I.officeName >= 0 ? (c[I.officeName] ?? "").trim() || null : null,
    });
  }
}
console.log(`介護保険1.CSV: ${areas.length} 拠点 / 認定行 ${csvRows.length} 件`);
if (badLevel.length) {
  const uniq = [...new Set(badLevel.map((b) => b.split('"')[1]))];
  console.log(`  ⚠ 要介護度が DB の値に対応しないため除外: ${badLevel.length} 行 (${uniq.join(" / ")})`);
}

// ─── 2) clients を引く ───────────────────────────────────────────────────────
const insuredNumbers = [...new Set(csvRows.map((r) => r.insured))];
const clients = [];
for (let i = 0; i < insuredNumbers.length; i += 100) {
  const { data, error } = await sb
    .from("clients").select("id, name, insured_number, tenant_id")
    .in("insured_number", insuredNumbers.slice(i, i + 100));
  if (error) { console.error("clients 取得失敗:", error.message); process.exit(1); }
  clients.push(...(data ?? []));
}
const byInsured = new Map();
for (const c of clients) {
  if (!byInsured.has(c.insured_number)) byInsured.set(c.insured_number, []);
  byInsured.get(c.insured_number).push(c);
}
console.log(`clients 解決: ${byInsured.size} / ${insuredNumbers.length} 番号`);

// ─── 3) 既存の認定行 ─────────────────────────────────────────────────────────
const clientIds = clients.map((c) => c.id);
const existing = [];
for (let i = 0; i < clientIds.length; i += 100) {
  const { data, error } = await sb
    .from("client_insurance_records")
    .select("id, client_id, care_level, certification_start_date, certification_end_date, limit_period_start, limit_period_end, service_limit_amount")
    .in("client_id", clientIds.slice(i, i + 100));
  if (error) { console.error("既存認定の取得失敗:", error.message); process.exit(1); }
  existing.push(...(data ?? []));
}
const existByClient = new Map();
for (const r of existing) {
  if (!existByClient.has(r.client_id)) existByClient.set(r.client_id, []);
  existByClient.get(r.client_id).push(r);
}
console.log(`既存の認定行: ${existing.length} 件\n`);

// ─── 4) 計画 ─────────────────────────────────────────────────────────────────
const inserts = [], conflicts = [], dupClient = new Set(), noClient = new Set();
/**
 * ⚠ **同じ認定を 1 回の実行で何行も INSERT しない**ための索引。
 *
 *   同じ利用者マスタ CSV が複数の場所に置かれている:
 *     利用者データ/全居宅/介護保険1_R8-06_全件.CSV
 *     利用者データ/全社_R8-08/介護保険1.CSV
 *     利用者データ/<拠点>/介護保険1.CSV
 *   全部を読むので、1 人の同じ認定が csvRows に 3 回出てくる。
 *
 *   既存行との突き合わせ (`same`) は **実行前のスナップショット**しか見ないので、
 *   この実行で足した行は弾けない。結果、同じ認定が CSV ファイルの数だけ入る。
 *
 *   2026-08-31 に実データで確認: 同じ内容の認定が 86 組 / 余分な行 164 件あり、
 *   志村 道子 は 6 行すべてが「要介護4 / 30938 / 2026-06-01〜2027-05-31」だった。
 *   dedupe_insurance_records.mjs で 54 行を片付けたが、**発生源はここ**。
 *
 *   同じ (client_id, 認定開始日) が来たら、**値が埋まっているほうを残す**。
 */
const plannedByKey = new Map();
const filledCount = (row) => Object.values(row).filter((v) => v != null && v !== "").length;
for (const r of csvRows) {
  const cs = byInsured.get(r.insured);
  if (!cs || cs.length === 0) { noClient.add(r.insured); continue; }
  if (cs.length > 1) { dupClient.add(`${r.insured} ${r.name}`); continue; }
  const c = cs[0];
  const rows = existByClient.get(c.id) ?? [];
  const same = rows.find((x) => x.certification_start_date === r.certStart);
  if (same) {
    const diffs = [];
    if (same.care_level !== r.level) diffs.push(`要介護度 DB=${same.care_level} CSV=${r.level}`);
    if (same.certification_end_date !== r.certEnd) diffs.push(`認定終了 DB=${same.certification_end_date} CSV=${r.certEnd}`);
    if (r.limEnd && same.limit_period_end !== r.limEnd) diffs.push(`限度額適用終了 DB=${same.limit_period_end} CSV=${r.limEnd}`);
    if (r.limit != null && same.service_limit_amount !== r.limit) diffs.push(`限度額 DB=${same.service_limit_amount} CSV=${r.limit}`);
    if (diffs.length) conflicts.push({ insured: r.insured, name: r.name, area: r.area, id: same.id, start: r.certStart, diffs });
    continue;
  }
  const row = {
    _label: `${r.area} ${r.insured} ${r.name}`,
    tenant_id: c.tenant_id,
    client_id: c.id,
    insured_number: r.insured,
    insurer_number: r.insurer,
    insurer_name: r.insurerName,
    care_level: r.level,
    certification_start_date: r.certStart,
    certification_end_date: r.certEnd,
    limit_period_start: r.limStart,
    limit_period_end: r.limEnd,
    service_limit_amount: r.limit,
    copay_rate: COPAY_BY_RATE[r.rate] ?? null,
    certification_status: r.status,
    record_status: r.status,
    certification_date: r.certDate,
    effective_date: r.certStart,
    care_manager: r.cmName,
    care_manager_org: r.officeName,
    notes: MARK,
  };
  // 同じ (利用者, 認定開始日) が既にこの実行で計画済みなら、値が多いほうを残す
  const key = `${c.id}|${r.certStart}`;
  const prev = plannedByKey.get(key);
  if (prev) {
    if (filledCount(row) > filledCount(prev)) {
      inserts[inserts.indexOf(prev)] = row;
      plannedByKey.set(key, row);
    }
    continue;
  }
  plannedByKey.set(key, row);
  inserts.push(row);
}

// ─── 5) 表示 ─────────────────────────────────────────────────────────────────
console.log(`${EXECUTE ? "🔴 本番実行" : "DRY RUN"}`);
console.log(`\n=== INSERT 対象 ${inserts.length} 行 ===`);
const byArea = {};
for (const p of inserts) (byArea[p._label.split(" ")[0]] ??= []).push(p);
for (const [a, ps] of Object.entries(byArea)) {
  console.log(`  ${a}: ${ps.length} 行`);
  for (const p of ps.slice(0, 5))
    console.log(`     ${p.insured_number} ${p._label.split(" ").slice(2).join(" ")} ${p.care_level} ${p.certification_start_date}〜${p.certification_end_date}`);
  if (ps.length > 5) console.log(`     … 他 ${ps.length - 5} 行`);
}
console.log(`\n=== 既存行と値が違う (書き換えない・要判断) ${conflicts.length} 件 ===`);
for (const c of conflicts.slice(0, 25))
  console.log(`  ${c.area} ${c.insured} ${c.name} (${c.start}): ${c.diffs.join(" / ")}`);
if (conflicts.length > 25) console.log(`  … 他 ${conflicts.length - 25} 件`);
console.log(`\n被保険者番号が複数 clients に紐づく (skip): ${dupClient.size} 件`);
console.log(`clients に居ない被保険者番号 (skip): ${noClient.size} 件`);

// 差分の内訳 (null 埋めなのか、値の食い違いなのか)
const kinds = {};
for (const c of conflicts) for (const d of c.diffs) {
  const k = `${d.split(" ")[0]} ${/DB=null/.test(d) ? "【DBがnull】" : "【DBに別の値】"}`;
  kinds[k] = (kinds[k] ?? 0) + 1;
}
console.log("\n差分の内訳:", JSON.stringify(kinds, null, 1));
const realConflicts = conflicts.filter((c) => c.diffs.some((d) => !/DB=null/.test(d)));
if (realConflicts.length) {
  console.log(`\n★ DB に別の値が入っている ${realConflicts.length} 件 (要確認):`);
  for (const c of realConflicts.slice(0, 30))
    console.log(`  ${c.area} ${c.insured} ${c.name} (${c.start}): ${c.diffs.filter((d) => !/DB=null/.test(d)).join(" / ")}`);
  if (realConflicts.length > 30) console.log(`  … 他 ${realConflicts.length - 30} 件`);
}

if (!EXECUTE) {
  const p = join(__dirname, "_import_cert_history_dryrun.json");
  writeFileSync(p, JSON.stringify({ inserts: inserts.length, conflicts, realConflicts }, null, 1));
  console.log(`\nDRY RUN — 何も書き込んでいません。--execute で INSERT します。`);
  console.log(`差分の全量: ${p}`);
  process.exit(0);
}

// ─── 6) 実行 ─────────────────────────────────────────────────────────────────
const done = [];
for (let i = 0; i < inserts.length; i += 200) {
  const chunk = inserts.slice(i, i + 200).map(({ _label, ...row }) => row);
  const { data, error } = await sb.from("client_insurance_records").insert(chunk).select("id");
  if (error) { console.error(`  ✗ chunk ${i}: ${error.message}`); continue; }
  done.push(...(data ?? []).map((d) => d.id));
}
const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const outPath = join(__dirname, `_import_cert_history_${stamp}.json`);
writeFileSync(outPath, JSON.stringify({ insertedIds: done, conflicts }, null, 1));
console.log(`\n完了: ${done.length}/${inserts.length} 行 INSERT`);
console.log(`挿入 id: ${outPath} (取り消しはこの id を DELETE)`);
console.log("反映後は伝送突合ハーネスを回し直して差が減ることを確認してください。");
