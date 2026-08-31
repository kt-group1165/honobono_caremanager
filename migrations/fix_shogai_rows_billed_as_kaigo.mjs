#!/usr/bin/env node
/**
 * 障害取込した実績のうち「ほのぼのが介護保険で請求している行」を介護へ振り替える。
 *
 * ── なぜ要るのか ──────────────────────────────────────────────
 * MEISAI (稼働データ) は **事業者エントリごとにファイルが分かれる**。障害エントリの
 * ファイルにある行は サービスコード `021xxx` を持つが、**それは制度を表していない**。
 * 同じ利用者・同じ `021001` の 9 行が、ほのぼの側では 障害 2 行 / 介護 7 行 に
 * 分かれていた (高品 田村ムラエ 2026-06)。
 *
 *   ほのぼの 障害 KJ   111215 身体夜0.5 ×9      (= TJ の 9 日)
 *   ほのぼの 介護 KK   1211 身体介護2 ×22 / 1112 身体1・夜 ×4 / 1411 身体介護4 ×4
 *
 * 当方は 021xxx を全部障害に入れるため、障害を 7 行ぶん過大・介護を 5,141 単位ぶん
 * 過少に請求していた。介護取込は `021xxx` を解決できず落としている (「請求漏れなら
 * ここに出る」と自分で書いている箇所)。
 *
 * ── 何を根拠に振り替えるか (推測しない) ───────────────────────
 *   ① その利用者が **介護保険の被保険者番号を持つ** (= 両制度)
 *   ② その利用者が TJ (ほのぼのの障害実績記録票) に載っている拠点である
 *   ③ **その日に TJ が障害の提供を 1 件も出していない**
 * の 3 つを同時に満たす行だけ。①②で「TJ に無い＝もう一方の制度」の危うい推論を
 * 両制度利用者に限定する (memory: feedback_negative_inference_system_label)。
 *
 * 所要時間 → 介護サービス名 は **ほのぼのの請求で裏が取れた組合せだけ**を持つ。
 * 未確認の組合せが出たら **1 行も書かずに停止する**。境界 (60分ちょうどが身体2 など)
 * を推測で埋めると誤請求になるため。
 *
 * ⚠ 取込は「その拠点の対象月ぶんを消して入れ直す」ので、**取込を回したら再実行**する。
 *
 *   TARGET_MONTH=2026-06 node migrations/fix_shogai_rows_billed_as_kaigo.mjs
 *   TARGET_MONTH=2026-06 node migrations/fix_shogai_rows_billed_as_kaigo.mjs --execute
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const TARGET_MONTH = process.env.TARGET_MONTH || "2026-06";
const YM = TARGET_MONTH.replace("-", "");
const MONTH_FIRST = `${TARGET_MONTH}-01`;
const MONTH_LAST = new Date(Date.UTC(+TARGET_MONTH.slice(0, 4), +TARGET_MONTH.slice(5, 7), 0))
  .toISOString().slice(0, 10);
const MARKER = "[制度是正 TJ非該当→介護]";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定");
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function rest(qs) {
  const r = await fetch(`${SB}/rest/v1/${qs}`, { headers: H });
  const j = await r.json();
  if (!r.ok || !Array.isArray(j)) throw new Error(`${qs}: ${JSON.stringify(j)}`);
  return j;
}
async function fetchAll(table, select, extra = "") {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = await rest(`${table}?select=${select}${extra}&offset=${from}&limit=1000`);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

// ── ① TJ (ほのぼのの障害実績記録票) を読む ────────────────────────────────
const DENSOU_ROOT = fileURLToPath(new URL("../伝送データ", import.meta.url));
function collectTj(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectTj(p, out);
    else if (/^TJ.*\.CSV$/i.test(e.name) && !e.name.includes("解説")) out.push(p);
  }
  return out;
}
const tjDays = new Set();     // `受給者証|YYYY-MM-DD`
const tjPersons = new Set();  // 受給者証 (= その拠点の TJ が届いている人)
let tjFiles = 0;
for (const f of collectTj(DENSOU_ROOT)) {
  if (!f.includes(YM)) continue;
  tjFiles++;
  // 数字と記号しか見ないので cp932 のまま latin1 で読んでよい
  for (const line of fs.readFileSync(f, "latin1").split(/\r?\n/)) {
    const c = line.split(",").map((v) => v.replace(/^"|"$/g, ""));
    if (c[0] !== "2" || c[2] !== "J611") continue;
    const ben = c[7];
    if (!ben) continue;
    tjPersons.add(ben);
    if (c[3] !== "02") continue;                      // 明細行のみ
    const day = String(c[10] || "").padStart(2, "0");
    if (day === "00") continue;
    tjDays.add(`${ben}|${TARGET_MONTH}-${day}`);
  }
}
console.log(`── TJ ── ${tjFiles} ファイル / ${tjPersons.size} 名 / ${tjDays.size} 日`);
if (!tjFiles) throw new Error(`伝送データ に ${YM} の TJ が 1 つも無い。判定できないので中止`);

// ── ② DB: 障害取込した対象月の実績 ───────────────────────────────────────
const rows = await fetchAll(
  "kaigo_visit_schedule",
  "id,user_id,office_id,visit_date,start_time,end_time,service_type,system,notes",
  `&visit_date=gte.${MONTH_FIRST}&visit_date=lte.${MONTH_LAST}&notes=like.*MEISAI障害取込*`,
);
console.log(`── DB ── 障害取込行 ${rows.length}`);

const offices = Object.fromEntries((await fetchAll("offices", "id,name")).map((o) => [o.id, o.name]));
const clientName = new Map((await fetchAll("clients", "id,name")).map((c) => [c.id, c.name]));
const benByClient = new Map();
for (const c of await fetchAll("shougai_certifications", "client_id,beneficiary_number")) {
  if (c.beneficiary_number && !benByClient.has(c.client_id)) benByClient.set(c.client_id, c.beneficiary_number);
}
const hasKaigo = new Set(
  (await fetchAll("client_insurance_records", "client_id,insured_number"))
    .filter((r) => r.insured_number).map((r) => r.client_id),
);

// ── ③ 対象行の抽出 ───────────────────────────────────────────────────────
const EXCLUDE_NAME = /重訪|重度|同行/;   // TJ が積み上げなので日単位でも判定できない
const targets = [];
for (const r of rows) {
  const ben = benByClient.get(r.user_id);
  if (!ben) continue;
  if (!hasKaigo.has(r.user_id)) continue;             // ① 両制度の人だけ
  if (!tjPersons.has(ben)) continue;                  // ② TJ が届いている人だけ
  if (EXCLUDE_NAME.test(r.service_type)) continue;
  if (tjDays.has(`${ben}|${r.visit_date}`)) continue;  // ③ その日に障害提供がある → 触らない
  targets.push({ ...r, ben });
}
console.log(`── 対象 ── ${targets.length} 行 / ${new Set(targets.map((t) => t.user_id)).size} 名\n`);
if (!targets.length) {
  console.log("該当なし。何もしない。");
  process.exit(0);
}

// ── ④ 所要時間 + 時間帯 → 介護サービス名 (裏の取れた組合せのみ) ──────────
// ほのぼのの 2026-06 請求で実証した対応。band は上端を含む
// (18:00-18:30=30分→身体1 / 09:30-10:30=60分→身体2 / 13:30-15:30=120分→身体4)。
const CONFIRMED = new Map([
  ["1|夜間", "身体介護１・夜"],
  ["2|日中", "身体介護２"],
  ["4|日中", "身体介護４"],
]);
const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const bandOf = (min) => (min <= 30 ? 1 : min <= 60 ? 2 : min <= 90 ? 3 : min <= 120 ? 4 : 0);
const zoneOf = (min) => {
  const h = min / 60;
  if (h >= 22 || h < 6) return "深夜";
  if (h < 8) return "早朝";
  if (h < 18) return "日中";
  return "夜間";
};

const unknown = [];
for (const t of targets) {
  const s = toMin(t.start_time), e0 = toMin(t.end_time);
  const dur = e0 > s ? e0 - s : e0 + 1440 - s;
  const key = `${bandOf(dur)}|${zoneOf(s)}`;
  t.dur = dur;
  t.key = key;
  t.newName = CONFIRMED.get(key) ?? null;
  if (!t.newName) unknown.push(t);
}
if (unknown.length) {
  console.error(`✖ 裏の取れていない所要時間区分が ${unknown.length} 行ある。**1 行も書かずに中止**する。`);
  for (const t of unknown) {
    console.error(`   ${offices[t.office_id] ?? ""} ${clientName.get(t.user_id) ?? t.user_id} `
      + `${t.visit_date} ${t.start_time.slice(0, 5)}-${t.end_time.slice(0, 5)} `
      + `${t.dur}分 ${t.key}  現: ${t.service_type}`);
  }
  console.error("\n  ほのぼのの KK でその回が何のコードで請求されているかを確認し、");
  console.error("  CONFIRMED に足してから再実行すること。推測で埋めない。");
  process.exit(2);
}

// ── ⑤ 介護マスタに実在するか (対象月世代) ────────────────────────────────
const names = [...new Set(targets.map((t) => t.newName))];
const master = await rest(
  `kaigo_service_codes?select=service_name,service_code,units,valid_from,valid_until`
  + `&system=eq.${encodeURIComponent("介護")}&service_category=eq.11`
  + `&service_name=in.(${names.map((n) => `"${n}"`).join(",")})`,
);
const inMonth = (r) => (!r.valid_from || r.valid_from <= MONTH_FIRST)
  && (!r.valid_until || r.valid_until >= MONTH_FIRST);
const byName = new Map();
for (const r of master.filter(inMonth)) if (!byName.has(r.service_name)) byName.set(r.service_name, r);
const missing = names.filter((n) => !byName.has(n));
if (missing.length) {
  console.error(`✖ 介護マスタ (system=介護 / 種類11 / ${TARGET_MONTH} 世代) に無い: ${missing.join(" / ")}`);
  process.exit(2);
}

// ── ⑥ 内容表示 ───────────────────────────────────────────────────────────
const byClient = new Map();
for (const t of targets) {
  const k = `${offices[t.office_id] ?? t.office_id}|${clientName.get(t.user_id) ?? t.user_id}|${t.ben}`;
  if (!byClient.has(k)) byClient.set(k, []);
  byClient.get(k).push(t);
}
for (const [k, list] of byClient) {
  const [office, name, ben] = k.split("|");
  console.log(`### ${office} ${name} (受給者証 ${ben})  ${list.length} 行`);
  for (const t of list.sort((a, b) => a.visit_date.localeCompare(b.visit_date))) {
    const m = byName.get(t.newName);
    console.log(`   ${t.visit_date} ${t.start_time.slice(0, 5)}-${t.end_time.slice(0, 5)} `
      + `${String(t.dur).padStart(3)}分  ${t.service_type.padEnd(12)} → ${t.newName} (${m.service_code} ${m.units}単位)`);
  }
  const tally = new Map();
  for (const t of list) tally.set(t.newName, (tally.get(t.newName) ?? 0) + 1);
  console.log(`   介護へ: ${[...tally].map(([n, c]) => `${n}×${c}`).join(" / ")}\n`);
}

if (!EXECUTE) {
  console.log(`DRY RUN。書き込むには --execute を付ける (${targets.length} 行)。`);
  process.exit(0);
}

// ── ⑦ 実行 ───────────────────────────────────────────────────────────────
let ok = 0;
for (const t of targets) {
  const notes = (t.notes || "").includes(MARKER) ? t.notes : `${t.notes || ""} ${MARKER}`.trim();
  const res = await fetch(`${SB}/rest/v1/kaigo_visit_schedule?id=eq.${t.id}`, {
    method: "PATCH",
    headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify({ system: "介護", service_type: t.newName, notes }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`✖ 更新失敗 id=${t.id}: ${res.status} ${body}`);
    process.exit(1);
  }
  ok++;
}
console.log(`✅ ${ok} 行を介護へ振り替えた。`);
console.log("⚠ 取込を回すと元に戻るので、取込後はこの script を再実行すること。");
