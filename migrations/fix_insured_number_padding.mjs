// ============================================================================
// clients.insured_number の桁落ち (先頭ゼロの欠落) を 10 桁に揃える。
//
//   node migrations/fix_insured_number_padding.mjs             # DRY RUN
//   node migrations/fix_insured_number_padding.mjs --execute
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
//   被保険者番号は 10 桁。ところが clients 側だけ桁が落ちているものがある。
//   2026-08-31 時点:
//     client_insurance_records.insured_number  7,265 件すべて 10 桁 (綺麗)
//     clients.insured_number                   5,396 件中 **89 件が 10 桁未満**
//                                              (1〜9 桁。"22717" "7012" 等)
//
//   同じ人が "22717" と "0000022717" の 2 件に割れて、**別人として扱われる**。
//   引き当ても統合も (保険者, 被保番) を突き合わせるので、桁が違うと外れる。
//   実際 木更津市 (122069) で 4 組の重複を作っていた。
//
// ── どう直すか ──────────────────────────────────────────────────────────
//   数字だけで 10 桁未満のものを 10 桁ゼロ埋めする。ただし **推測では直さない**。
//   ゼロ埋めした値が
//     ① その利用者自身の認定レコードに (同じ保険者で) 実在する   … 最優先
//     ② 利用者マスタ CSV に (同じ保険者・同じ氏名で) 実在する
//   のどちらかで裏が取れたものだけを直す。取れなければ一覧に出して触らない。
//
//   ⚠ 英字始まり ("H551079091" 等 36 件) は桁が合っているので対象外。
//   ⚠ ゼロ埋めすると **別人と衝突する**場合も触らない (先に人物の同定が要る)。
//
//   変更前の値は migrations/_insured_number_padding_backup.json に残す。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const BACKUP = path.join(KAIGO, "migrations/_insured_number_padding_backup.json");

const env = {};
for (const l of readFileSync(path.join(KAIGO, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

const sjis = new TextDecoder("shift_jis");
function parseLine(line) {
  const out = []; let f = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { out.push(f); f = ""; }
    else f += c;
  }
  out.push(f); return out;
}
function readCsv(p) {
  const L = sjis.decode(readFileSync(p)).split(/\r?\n/).filter((x) => x !== "");
  if (!L.length) return { idx: {}, rows: [] };
  const h = parseLine(L[0]).map((x) => x.trim());
  const idx = {}; h.forEach((x, i) => { if (!(x in idx)) idx[x] = i; });
  return { idx, rows: L.slice(1).map(parseLine) };
}
const g = (r, idx, k) => { const i = idx[k]; return i == null ? null : (r[i] ?? "").trim() || null; };
const normNm = (s) => (s ?? "").normalize("NFKC").replace(/[\s　]/g, "");

async function fetchAll(build) {
  const out = [];
  // ⚠ order 無しで range を回すと行が重複・欠落し得る。必ず並べる
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

function collectKaigoCsvs() {
  const base = path.join(KAIGO, "利用者データ");
  const out = [];
  const walk = (d, depth) => {
    if (depth > 3) return;
    let ents; try { ents = readdirSync(d); } catch { return; }
    for (const n of ents) {
      const p = path.join(d, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (/^介護保険.*\.csv$/i.test(n)) out.push(p);
    }
  };
  walk(base, 0);
  return out;
}

async function main() {
  console.log(`=== clients.insured_number を 10 桁に揃える ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);

  const clients = (await fetchAll(() => sb.from("clients")
    .select("id, name, insurer_number, insured_number, birth_date, deleted_at")))
    .filter((c) => !c.deleted_at);
  const certs = await fetchAll(() => sb.from("client_insurance_records")
    .select("client_id, insurer_number, insured_number"));

  // 認定側の (client, 保険者|被保番)
  const certByClient = new Map();
  for (const r of certs) {
    if (!r.insured_number) continue;
    if (!certByClient.has(r.client_id)) certByClient.set(r.client_id, new Set());
    certByClient.get(r.client_id).add(`${r.insurer_number}|${r.insured_number}`);
  }
  // CSV の (保険者|被保番) -> 氏名
  const csvByPair = new Map();
  for (const f of collectKaigoCsvs()) {
    const { idx, rows } = readCsv(f);
    if (!("被保険者番号" in idx) || !("保険者番号" in idx)) continue;
    for (const r of rows) {
      const k = `${g(r, idx, "保険者番号")}|${g(r, idx, "被保険者番号")}`;
      const nm = g(r, idx, "利用者名");
      if (nm && !csvByPair.has(k)) csvByPair.set(k, nm);
    }
  }
  // いま使われている (保険者|被保番) → 誰か (衝突検出用)
  const owner = new Map();
  for (const c of clients) {
    if (c.insurer_number && c.insured_number) owner.set(`${c.insurer_number}|${c.insured_number}`, c);
  }

  const target = clients.filter((c) => c.insured_number && /^\d+$/.test(c.insured_number) && c.insured_number.length < 10);
  console.log(`10 桁未満の数字を持つ利用者: ${target.length} 名\n`);

  const plan = [], skip = [], dupPairs = [];
  for (const c of target) {
    const padded = c.insured_number.padStart(10, "0");
    const key = `${c.insurer_number}|${padded}`;
    const viaCert = certByClient.get(c.id)?.has(key) ?? false;
    const csvName = csvByPair.get(key);
    const viaCsv = csvName != null && normNm(csvName) === normNm(c.name);

    if (!viaCert && !viaCsv) {
      skip.push(`${c.name.padEnd(12)} ${c.insurer_number}|${c.insured_number} → ${padded} の裏が取れない` +
        (csvName ? ` (CSV は「${csvName}」)` : " (CSV に無い)"));
      continue;
    }
    const clash = owner.get(key);
    if (clash && clash.id !== c.id) {
      // 衝突相手が **同じ氏名・同じ生年月日** なら、桁落ちで割れた同一人物。
      // ゼロ埋めしても衝突するだけなので、統合の候補として別に出す。
      const same = normNm(clash.name) === normNm(c.name) && clash.birth_date && clash.birth_date === c.birth_date;
      if (same) dupPairs.push({ short: c, full: clash, padded });
      else skip.push(`${c.name.padEnd(12)} ${c.insurer_number}|${c.insured_number} → ${padded} は別人「${clash.name}」が使用中 (人物の同定が要る)`);
      continue;
    }
    plan.push({ c, padded, why: viaCert ? "本人の認定にある" : "CSV で氏名一致" });
  }

  console.log(`― 直す ${plan.length} 名 ―`);
  for (const p of plan.slice(0, 25)) {
    console.log(`   ${p.c.name.padEnd(12)} ${p.c.insurer_number}|${String(p.c.insured_number).padEnd(10)} → ${p.padded}  (${p.why})`);
  }
  if (plan.length > 25) console.log(`   … 他 ${plan.length - 25} 名`);
  if (dupPairs.length) {
    console.log(`\n― 桁落ちで割れた同一人物 ${dupPairs.length} 組 (ゼロ埋めせず統合する) ―`);
    for (const d of dupPairs) {
      console.log(`   ${d.short.name.padEnd(12)} 生${d.short.birth_date}  ${d.short.insurer_number}|${d.short.insured_number}  ⇔  ${d.full.insurer_number}|${d.full.insured_number}`);
    }
    console.log("   → 短いほうを 10 桁に寄せると衝突するので、統合を先にやる必要がある。");
    console.log("     merge_duplicate_clients.mjs は (保険者,被保番) が一致しないと拾えない。");
  }
  if (skip.length) {
    console.log(`\n― 裏が取れないので触らない ${skip.length} 名 ―`);
    console.log("   ※ ほとんどが木更津市 (122069)。利用者マスタ CSV が手元に無いため確認できない。");
    for (const s of skip.slice(0, 10)) console.log(`   ${s}`);
    if (skip.length > 10) console.log(`   … 他 ${skip.length - 10} 名`);
  }

  // 直したあとに重複が確定する人物
  const after = new Map();
  for (const c of clients) {
    const num = plan.find((p) => p.c.id === c.id)?.padded ?? c.insured_number;
    if (!c.insurer_number || !num) continue;
    const k = `${c.insurer_number}|${num}`;
    if (!after.has(k)) after.set(k, []);
    after.get(k).push(c);
  }
  const dups = [...after.entries()].filter(([, v]) => v.length > 1);
  console.log(`\n揃えたあとに重複が確定する人物: ${dups.length} 組`);
  for (const [k, v] of dups) console.log(`   ${k}  ${v.map((c) => `${c.name}(生${c.birth_date ?? "?"})`).join(" / ")}`);
  if (dups.length) console.log("   → このあと merge_duplicate_clients.mjs で統合できる");

  if (!EXECUTE) { console.log("\n(--execute で反映)"); return; }

  const backup = plan.map((p) => ({ id: p.c.id, name: p.c.name, before: p.c.insured_number, after: p.padded }));
  let ok = 0, ng = 0;
  for (const p of plan) {
    const { error } = await sb.from("clients").update({ insured_number: p.padded }).eq("id", p.c.id);
    if (error) { console.error(`✗ ${p.c.name}: ${error.message}`); ng++; continue; }
    ok++;
  }
  writeFileSync(BACKUP, JSON.stringify(backup, null, 2), "utf8");
  console.log(`\n更新 ${ok} 名 / 失敗 ${ng} 名`);
  console.log(`変更前の値を ${path.basename(BACKUP)} に保存しました`);
}

main().catch((e) => { console.error(e); process.exit(1); });
