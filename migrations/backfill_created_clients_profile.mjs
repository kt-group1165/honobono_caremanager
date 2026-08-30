// ============================================================================
// 伝送取込で作った利用者に **フリガナ・性別・郵便番号** を埋める。
//
//   import_kyotaku_claims_from_kk.mjs --create-missing は 氏名・生年・住所・電話
//   しか入れておらず、フリガナが無いため利用者一覧であいうえお順に並ばず
//   「他」に落ちていた (船橋 坂田茂 が見つからない、で発覚)。
//   性別・郵便番号も同様に欠けていた。
//
//   出どころは 利用者データ/**/基本情報*.CSV (共有マスタ)。
//     0 利用者番号 / 3 氏名 / 6 フリガナ(姓名) / 8 性別 / 11 生年月日
//     12 郵便番号 / 13 住所 / 14 電話
//
//   node migrations/backfill_created_clients_profile.mjs            # DRY RUN
//   node migrations/backfill_created_clients_profile.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";

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

/** 利用者番号 → 基本情報 */
function loadBase() {
  const base = path.join(KAIGO, "利用者データ");
  const by = new Map();
  const walk = (d, depth) => {
    if (depth > 3 || !existsSync(d)) return;
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p, depth + 1); continue; }
      if (!/^基本情報.*\.CSV$/i.test(n) || !st.size) continue;
      for (const line of iconv.decode(readFileSync(p), "Shift_JIS").split(/\r?\n/)) {
        const c = splitCsv(line).map((s) => s.trim());
        if (c.length < 15 || !c[0] || !c[3]) continue;
        by.set(c[0], {
          furigana: c[6] || null, gender: c[8] || null,
          postal_code: c[12] || null, address: c[13] || null, phone: c[14] || null,
        });
      }
    }
  };
  walk(base, 0);
  return by;
}

async function main() {
  console.log(`=== 伝送取込で作った利用者の profile 補完 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);
  const base = loadBase();
  console.log(`  基本情報 CSV: ${base.size} 名分\n`);

  const { data: ins, error } = await sb.from("client_insurance_records")
    .select("client_id, clients(id, name, user_number, furigana, gender, postal_code, address, phone)")
    .like("notes", "%月遅れで当初請求に居らず未登録%");
  if (error) { console.error(`✗ ${error.message}`); process.exit(1); }

  const seen = new Set(), plans = [], noBase = [];
  for (const r of ins ?? []) {
    const c = r.clients;
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    const b = base.get(c.user_number);
    if (!b) { noBase.push(`${c.name} (${c.user_number}): 基本情報 CSV に無い`); continue; }
    const set = {};
    for (const k of ["furigana", "gender", "postal_code", "address", "phone"]) {
      if (!c[k] && b[k]) set[k] = b[k];      // 既に入っている値は触らない
    }
    if (Object.keys(set).length) plans.push({ c, set });
  }

  for (const p of plans) {
    console.log(`  ${p.c.name.padEnd(14)} ${Object.entries(p.set).map(([k, v]) => `${k}=${v}`).join(" / ")}`);
  }
  if (noBase.length) {
    console.log(`\n  -- 基本情報が見つからないもの ${noBase.length} 件 --`);
    for (const n of noBase) console.log(`     ${n}`);
  }
  console.log(`\n  対象 ${plans.length} 名 (検出 ${seen.size} 名)`);
  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で保存します。"); return; }

  for (const p of plans) {
    const { error: e2 } = await sb.from("clients").update(p.set).eq("id", p.c.id);
    if (e2) { console.error(`✗ ${p.c.name}: ${e2.message}`); process.exit(1); }
    console.log(`  ✓ ${p.c.name}`);
  }
  console.log(`\n✓ ${plans.length} 名を補完しました`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
