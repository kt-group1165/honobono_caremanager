// ============================================================================
// import_shougai_cert_new_generation.mjs のバグ修正 (2026-09-07)
//
// バグ: 2026-09-07 に新規INSERTした109件の insurer_municipality に、
//   CSV列21(支給市町村)の「名称」("千葉市"等) をそのまま入れてしまった。
//   本来は6桁の市町村番号("121004"等)が入るべき列。check:densouの
//   「障害の市町村番号が検証数字を通らない」が 1件→108件 に悪化して発覚。
//
// 直し方 (H指示・2026-09-07):
//   対象は ★今日(2026-09-06 00:00 UTC以降)作成の行 かつ ★番号が6桁mod10を
//   通らない行 だけに厳密に限定する (既存の正しい行を巻き込まない)。
//   復元値は ★同じclient_idの「直前の世代」(certification_start_dateが
//   1つ前) のinsurer_municipality。直前の世代が無い/その値も不正なら
//   ★推測で埋めず、一覧に出して人の確認に回す。
//
//   node migrations/fix_shogai_cert_new_generation_municipality.mjs            # DRY RUN
//   node migrations/fix_shogai_cert_new_generation_municipality.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// src/lib/insurer-number.ts の isValidInsurerNumber と同じ算法 (modulus10)。
// ⚠ このscriptは plain `node` で動かす前提 (tsxを介さない) なので .ts を
//   直接importできない。アルゴリズムだけ複製する (障害の市町村番号も同じmod10。
//   insurer-number.tsのdocコメント参照)。
function insurerCheckDigit(five) {
  if (!/^\d{5}$/.test(five)) return null;
  const weights = [2, 1, 2, 1, 2];
  let sum = 0;
  for (let i = 0; i < 5; i++) {
    let v = Number(five[i]) * weights[i];
    if (v > 9) v = Math.floor(v / 10) + (v % 10);
    sum += v;
  }
  const r = 10 - (sum % 10);
  return r === 10 ? 0 : r;
}
function isValidInsurerNumber(num) {
  const n = (num ?? "").trim();
  if (!/^\d{6}$/.test(n)) return false;
  return String(insurerCheckDigit(n.slice(0, 5))) === n[5];
}

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
// バグを持ち込んだINSERTの実行時刻 (2026-09-07T00:02 UTC台) より前の余裕を見た境界
const CREATED_CUTOFF = "2026-09-06T00:00:00Z";

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

async function fetchAll(table, select) {
  const out = []; let from = 0;
  for (;;) {
    const { data, error } = await sb.from(table).select(select).order("id").range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

async function main() {
  console.log(`=== 障害市町村番号 修正 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===`);
  console.log(`  対象: created_at >= ${CREATED_CUTOFF} かつ insurer_municipalityが不正 の行のみ\n`);

  // ⚠ 「今日作成の行」を特定するのに必要なので、対象client_idの全世代を取る
  const targets = await fetchAll("shougai_certifications",
    "id, client_id, certification_start_date, insurer_municipality, created_at");

  const broken = targets.filter((r) => r.created_at >= CREATED_CUTOFF && r.insurer_municipality && !isValidInsurerNumber(r.insurer_municipality));
  console.log(`対象行 (今日作成・番号が不正): ${broken.length} 件\n`);

  const byClient = new Map();
  for (const r of targets) {
    if (!byClient.has(r.client_id)) byClient.set(r.client_id, []);
    byClient.get(r.client_id).push(r);
  }

  const fixes = [], unresolved = [];
  for (const b of broken) {
    const siblings = (byClient.get(b.client_id) ?? [])
      .filter((r) => r.id !== b.id && r.certification_start_date && r.certification_start_date < b.certification_start_date)
      .sort((a, c) => c.certification_start_date.localeCompare(a.certification_start_date)); // 降順 → 先頭が直前の世代
    const prev = siblings[0];
    if (!prev) { unresolved.push({ ...b, reason: "直前の世代が無い" }); continue; }
    if (!prev.insurer_municipality || !isValidInsurerNumber(prev.insurer_municipality)) {
      unresolved.push({ ...b, reason: `直前の世代(${prev.certification_start_date})の番号も不正: "${prev.insurer_municipality}"` });
      continue;
    }
    fixes.push({ id: b.id, client_id: b.client_id, start: b.certification_start_date, from: b.insurer_municipality, to: prev.insurer_municipality, prevStart: prev.certification_start_date });
  }

  // 復元値がすべてmod10を通ることの再確認 (構築上通るはずだが明示的に確認する)
  const badFix = fixes.filter((f) => !isValidInsurerNumber(f.to));
  if (badFix.length) {
    console.error(`✗ 復元値がmod10を通らないものが ${badFix.length} 件あります。中断します。`);
    for (const f of badFix) console.error(`   ${f.id}: "${f.to}"`);
    process.exit(1);
  }

  console.log(`直前の世代から復元できる: ${fixes.length} 件`);
  console.log(`復元できない (要確認): ${unresolved.length} 件\n`);

  if (unresolved.length) {
    const { data: clients } = await sb.from("clients").select("id,name").in("id", [...new Set(unresolved.map((u) => u.client_id))]);
    const nameOf = new Map(clients.map((c) => [c.id, c.name]));
    console.log("--- 復元できない一覧 (触っていません) ---");
    for (const u of unresolved) console.log(`  ${nameOf.get(u.client_id) ?? u.client_id} [${u.certification_start_date}]  "${u.insurer_municipality}"  — ${u.reason}`);
    console.log("");
  }

  console.log("--- 復元内容 (先頭20件・全件は同じ形式) ---");
  for (const f of fixes.slice(0, 20)) console.log(`  ${f.id}  [${f.start}]  "${f.from}" → "${f.to}" (直前世代 ${f.prevStart})`);
  if (fixes.length > 20) console.log(`  … 他 ${fixes.length - 20} 件`);

  if (!EXECUTE) { console.log("\n※ DRY RUN のため UPDATE していません。--execute で反映します。"); return; }

  let n = 0;
  for (const f of fixes) {
    const { error } = await sb.from("shougai_certifications")
      .update({ insurer_municipality: f.to, updated_at: new Date().toISOString() }).eq("id", f.id);
    if (error) { console.error(`✗ ${f.id}: ${error.message}`); process.exit(1); }
    n++;
  }
  console.log(`\n✓ ${n} 件を修正しました`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
