// ============================================================================
// 取込マップ (_meisai_num_to_client_*.json) の client_id を現行の clients に張り替える。
//
// ── なぜ要るか ────────────────────────────────────────────────────────
//   重複統合 (merge_duplicate_clients.mjs) を回すと client_id が変わる。
//   マップは古い id を持ったままなので、次に取込を回すと FK 検証で止まり
//   **その拠点が丸ごと入らなくなる**。
//   2026-08-31 に実際に起きた: 姉ム 9 件 / 市原 3 件が clients に無くなり、
//   介護の取込が中止 → 伝送突合で「ほのぼのだけ 8 名」に見えていた。
//
// ── 直し方 ────────────────────────────────────────────────────────────
//   マップの 利用者番号 → MEISAI の氏名 → 現行 clients の氏名 で引き直す。
//   氏名が 1 件に決まったものだけ張り替え、0 件 / 複数件は**手当てを促して残す**
//   (推測で別人に付けると請求が別人に乗るため)。
//
//   node migrations/fix_meisai_map_after_merge.mjs            # DRY RUN
//   node migrations/fix_meisai_map_after_merge.mjs --execute  # 書き換え
//
//   MONTHS=202606,202607  MEISAI を探す提供年月 (既定 202606)
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";

const EXECUTE = process.argv.includes("--execute");
const MONTHS = (process.env.MONTHS || "202606").split(",");
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL;
const K = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !K) { console.error("✗ NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が無い"); process.exit(1); }
const H = { apikey: K, Authorization: `Bearer ${K}` };
const get = async (p) => {
  const r = await fetch(`${SB}/rest/v1/${p}`, { headers: H });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(`REST 失敗 [${p}]: ${JSON.stringify(j)}`);
  return j;
};

const norm = (s) => (s || "").normalize("NFKC").replace(/[（(].*$/, "").replace(/[\s　]/g, "");

const MIG = fileURLToPath(new URL("./", import.meta.url));
const ROOT = fileURLToPath(new URL("../サービス実績データ/", import.meta.url));

// ---- MEISAI から 利用者番号 → 氏名 ----------------------------------------
function loadNumToName() {
  const out = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/MEISAI.*\.csv$/i.test(e.name)) files.push(p);
    }
  };
  const files = [];
  for (const area of fs.readdirSync(ROOT)) {
    for (const ym of MONTHS) {
      const d = path.join(ROOT, area, ym);
      if (fs.existsSync(d)) walk(d);
    }
  }
  for (const f of files) {
    const rows = iconv.decode(fs.readFileSync(f), "cp932").split(/\r?\n/)
      .filter((l) => l.trim()).map((l) => l.split(",").map((c) => c.replace(/^"|"$/g, "")));
    if (!rows.length) continue;
    const idx = Object.fromEntries(rows[0].map((c, i) => [c.trim(), i]));
    const ni = idx["利用者名"], ci = idx["利用者番号"];
    if (ni == null || ci == null) continue;
    for (const r of rows.slice(1)) {
      if (r.length <= Math.max(ni, ci)) continue;
      const num = (r[ci] || "").trim();
      if (num && !out.has(num)) out.set(num, (r[ni] || "").trim());
    }
  }
  return out;
}

const numToName = loadNumToName();
console.log(`MEISAI から 利用者番号→氏名 を ${numToName.size} 件 読込 (${MONTHS.join(",")})\n`);

// ---- clients (氏名 → id[]) --------------------------------------------------
const alive = new Set();
const byName = new Map();
for (let from = 0; ; from += 1000) {
  const rows = await get(`clients?select=id,name&offset=${from}&limit=1000`);
  for (const r of rows) {
    alive.add(r.id);
    const k = norm(r.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r.id);
  }
  if (rows.length < 1000) break;
}
console.log(`clients 実在 ${alive.size} 件\n`);

// ---- マップを検査 -----------------------------------------------------------
let fixedTotal = 0, unresolvedTotal = 0;
for (const f of fs.readdirSync(MIG).filter((x) => /^_meisai_num_to_client.*\.json$/.test(x))) {
  const p = path.join(MIG, f);
  const map = JSON.parse(fs.readFileSync(p, "utf8"));
  const broken = Object.keys(map).filter((n) => map[n] && !alive.has(map[n]));
  if (!broken.length) continue;

  console.log(`■ ${f} — clients に無い client_id ${broken.length} 件`);
  let changed = 0;
  for (const num of broken) {
    const nm = numToName.get(num);
    if (!nm) { console.log(`   ⬜ ${num}: MEISAI に氏名が見つからない (手当て要)`); unresolvedTotal++; continue; }
    const cands = byName.get(norm(nm)) ?? [];
    if (cands.length === 1) {
      console.log(`   ✅ ${num} ${nm}: ${map[num].slice(0, 8)} → ${cands[0].slice(0, 8)}`);
      map[num] = cands[0];
      changed++;
    } else {
      console.log(`   ⬜ ${num} ${nm}: 候補 ${cands.length} 件 — 決められないので残す`);
      unresolvedTotal++;
    }
  }
  if (changed && EXECUTE) {
    fs.writeFileSync(p, JSON.stringify(map, null, 1) + "\n", "utf8");
    console.log(`   → 書き換え ${changed} 件`);
  }
  fixedTotal += changed;
  console.log("");
}

console.log(`張り替え ${fixedTotal} 件 / 未解決 ${unresolvedTotal} 件`);
if (!EXECUTE) console.log("※ DRY RUN のため書き換えていません。--execute で反映。");
