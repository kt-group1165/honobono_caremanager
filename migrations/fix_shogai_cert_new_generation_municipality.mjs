// ============================================================================
// import_shougai_cert_new_generation.mjs のバグ修正 (2026-09-05)
//
// バグ: 新規INSERTした109件の insurer_municipality に、CSV列21(支給市町村)の
//   「名称」("千葉市"等) をそのまま入れてしまった。本来は6桁の市町村番号
//   ("121004"等) が入るべき列。check:densouの「障害の市町村番号が検証数字を
//   通らない」が 1件→108件 に悪化して発覚 (2026-09-05)。
//
// 直し方: 新規行の直前の世代 (このscriptが複製元にした行=旧世代) が持っていた
//   正しい市町村番号に戻すだけ。旧世代は削除していないのでそのまま引ける。
//   ⚠ 名称→番号の変換テーブルは作らない (旧世代の値をそのまま使うほうが確実)。
//
//   node migrations/fix_shogai_cert_new_generation_municipality.mjs            # DRY RUN
//   node migrations/fix_shogai_cert_new_generation_municipality.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));

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

/** 6桁市町村番号 (JIS5桁+mod10検証数字) かどうか */
function mod10CheckDigit(five) {
  if (!/^\d{5}$/.test(five)) return null;
  const w = [2, 1, 2, 1, 2];
  let sum = 0;
  for (let i = 0; i < 5; i++) {
    let v = Number(five[i]) * w[i];
    if (v > 9) v = Math.floor(v / 10) + (v % 10);
    sum += v;
  }
  const r = 10 - (sum % 10);
  return r === 10 ? 0 : r;
}
const isValidCode = (n) => /^\d{6}$/.test(n) && String(mod10CheckDigit(n.slice(0, 5))) === n[5];

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
  console.log(`=== 障害市町村番号 修正 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const all = await fetchAll("shougai_certifications",
    "id, client_id, beneficiary_number, certification_start_date, insurer_municipality, created_at");

  // 名称のまま (=検証数字を通らない) の行を対象にする
  const broken = all.filter((r) => r.insurer_municipality && !isValidCode(r.insurer_municipality));
  console.log(`市町村番号が名称のまま (検証数字を通らない) の行: ${broken.length} 件\n`);

  const byBeneficiary = new Map();
  for (const r of all) {
    if (!r.beneficiary_number) continue;
    if (!byBeneficiary.has(r.beneficiary_number)) byBeneficiary.set(r.beneficiary_number, []);
    byBeneficiary.get(r.beneficiary_number).push(r);
  }

  const fixes = [], unresolved = [];
  for (const b of broken) {
    const siblings = (byBeneficiary.get(b.beneficiary_number) ?? [])
      .filter((r) => r.id !== b.id && r.insurer_municipality && isValidCode(r.insurer_municipality));
    if (siblings.length === 0) { unresolved.push(b); continue; }
    // 同じ受給者証番号で唯一/最頻の正しい番号を採用 (複数あれば最新のcreated_atのものではなく多数決)
    const counts = new Map();
    for (const s of siblings) counts.set(s.insurer_municipality, (counts.get(s.insurer_municipality) ?? 0) + 1);
    const best = [...counts.entries()].sort((a, b2) => b2[1] - a[1])[0][0];
    fixes.push({ id: b.id, client_id: b.client_id, from: b.insurer_municipality, to: best });
  }

  console.log(`旧世代から正しい番号を復元できる: ${fixes.length} 件`);
  console.log(`復元できない (同一受給者証番号に正しいコードを持つ行が無い): ${unresolved.length} 件\n`);
  if (unresolved.length) {
    const { data: clients } = await sb.from("clients").select("id,name").in("id", [...new Set(unresolved.map((u) => u.client_id))]);
    const nameOf = new Map(clients.map((c) => [c.id, c.name]));
    console.log("--- 復元できない一覧 (名称のまま) ---");
    for (const u of unresolved) console.log(`  ${nameOf.get(u.client_id) ?? u.client_id}: "${u.insurer_municipality}"`);
    console.log("");
  }

  console.log("--- 復元内容 (先頭20件) ---");
  for (const f of fixes.slice(0, 20)) console.log(`  ${f.id}  "${f.from}" → "${f.to}"`);
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
