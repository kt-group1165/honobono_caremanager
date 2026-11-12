/**
 * clients の text 型 日付列に混在する「YYYY/M/D」形式を ISO「YYYY-MM-DD」に揃える。
 *
 * ── 経緯 (2026-11-12) ───────────────────────────────────────────
 * order-app の ほのぼの CSV 取込 (apps/order-app/app/[tenant]/ClientsTab.tsx) が
 * CSV の値を trim しただけで入れていたため、ほのぼの由来の "2026/1/9" がそのまま
 * 残っていた。列が text なので ISO とスラッシュが混在する。
 * order-app 側の取込は 2026-11-12 に正規化済み (commit 9610a4c / f7f13a0)。
 * この script は ★既存値の是正★ を行う (取込を直した後に流すこと。順番を逆にすると
 * 次の取込でまた戻る)。
 *
 * ── 実測 (2026-11-12 / clients 9,317 名) ────────────────────────
 *   certification_start_date   ISO 6,060 / スラッシュ   304 / null 2,953
 *   certification_end_date     ISO 6,049 / スラッシュ   407 / null 2,861
 *   birth_date                 ISO 9,116 / スラッシュ     0 / null   201
 *   admission_date             ISO    46 / スラッシュ     0 / null 9,271
 *   discharge_date             ISO     4 / スラッシュ     0 / null 9,313
 *   → 是正対象は certification_start_date / certification_end_date の計 711 値。
 *     birth_date は ★ order-app から「入っていた」と報告があったが、当方 DB の実測では
 *     0 件。報告を鵜呑みにせず毎回測り直すこと (この script は実行時に必ず数え直す)。
 *
 * ⚠ 読めない値は ★触らない★ (null にしない)。別掲してログに出す。
 * ⚠ clients は order-app と共有のテーブル。実行前に他セッションへ声をかけること。
 *
 * 実行:
 *   node migrations/normalize_clients_date_text.mjs            # DRY RUN
 *   node migrations/normalize_clients_date_text.mjs --execute
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXECUTE = process.argv.includes("--execute");

const env = Object.fromEntries(
  fs.readFileSync(path.join(HERE, "..", ".env.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }),
);
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error(".env.local に Supabase の URL / SERVICE_ROLE_KEY が無い"); process.exit(1); }
const HEADERS = { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" };

async function rest(q, init) {
  const r = await fetch(SB_URL + "/rest/v1/" + q, { ...init, headers: { ...HEADERS, ...(init?.headers ?? {}) } });
  const txt = await r.text();
  if (!r.ok) throw new Error("REST " + r.status + ": " + txt);
  return txt ? JSON.parse(txt) : null;
}
async function pageAll(q) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const d = await rest(q + "&limit=1000&offset=" + off);
    out.push(...d);
    if (d.length < 1000) return out;
  }
}

/** 全角数字・年月日・スラッシュ・ドットを吸収して YYYY-MM-DD にする。読めなければ null */
function normalizeYmd(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // 全角 → 半角
  s = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(/[．。]/g, ".").replace(/[／]/g, "/").replace(/\s+/g, "");
  // 既に ISO
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (iso) return `${iso[1]}-${String(Number(iso[2])).padStart(2, "0")}-${String(Number(iso[3])).padStart(2, "0")}`;
  // YYYY年M月D日 / YYYY/M/D / YYYY.M.D
  const m = /^(\d{4})(?:年|\/|\.)(\d{1,2})(?:月|\/|\.)(\d{1,2})日?$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // 実在日チェック (2026/2/30 のような値を黙って 3/2 にしない)
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const COLS = ["certification_start_date", "certification_end_date", "birth_date", "admission_date", "discharge_date"];

const rows = await pageAll("clients?select=id,name," + COLS.join(",") + "&order=id.asc");
console.log("clients " + rows.length + " 名");
console.log("");

const stat = {};
for (const c of COLS) stat[c] = { ISO: 0, 要是正: 0, 読めない: 0, null: 0 };
const unreadable = [];
const updates = new Map(); // id -> patch

for (const r of rows) {
  for (const c of COLS) {
    const v = r[c];
    if (v == null || String(v).trim() === "") { stat[c].null++; continue; }
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { stat[c].ISO++; continue; }
    const norm = normalizeYmd(s);
    if (norm == null) {
      stat[c].読めない++;
      if (unreadable.length < 40) unreadable.push(`${r.name} ${c} = ${JSON.stringify(s)}`);
      continue; // ★ 触らない
    }
    stat[c].要是正++;
    if (!updates.has(r.id)) updates.set(r.id, { _name: r.name });
    updates.get(r.id)[c] = norm;
  }
}

console.log("列                              ISO    要是正   読めない     null");
for (const c of COLS) {
  const s = stat[c];
  console.log(c.padEnd(28) + String(s.ISO).padStart(7) + String(s.要是正).padStart(9)
    + String(s.読めない).padStart(10) + String(s.null).padStart(9));
}
const totalFix = COLS.reduce((a, c) => a + stat[c].要是正, 0);
const totalBad = COLS.reduce((a, c) => a + stat[c].読めない, 0);
console.log("");
console.log("是正する値 " + totalFix + " 個 / 対象 clients " + updates.size + " 名 / 読めず据え置き " + totalBad + " 個");

if (unreadable.length) {
  console.log("");
  console.log("--- 読めないので触らない値 (上位40) ---");
  for (const u of unreadable) console.log("  " + u);
}

// 変換前後の例を必ず出す (黙って書き換えない)
const sample = [...updates.entries()].slice(0, 10);
if (sample.length) {
  console.log("");
  console.log("--- 変換例 (先頭10名) ---");
  for (const [id, p] of sample) {
    const before = rows.find((x) => x.id === id);
    for (const c of COLS) {
      if (p[c] === undefined) continue;
      console.log("  " + p._name + "  " + c + ": " + JSON.stringify(before[c]) + " → " + p[c]);
    }
  }
}

if (!EXECUTE) {
  console.log("");
  console.log("*** DRY RUN *** 実行するには --execute を付ける");
  process.exit(0);
}

console.log("");
console.log("更新開始 (" + updates.size + " 名)…");
let done = 0, failed = 0;
for (const [id, p] of updates) {
  const patch = { ...p };
  delete patch._name;
  try {
    await rest("clients?id=eq." + id, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(patch),
    });
    done++;
  } catch (e) {
    failed++;
    console.error("  FAILED id=" + id + " (" + p._name + "): " + (e instanceof Error ? e.message : e));
    if (failed > 20) { console.error("失敗が 20 件を超えたので中断"); break; }
  }
  if (done % 100 === 0) console.log("  " + done + " / " + updates.size);
}
console.log("");
console.log("完了: 更新 " + done + " 名 / 失敗 " + failed + " 名");
if (failed) process.exit(2);
