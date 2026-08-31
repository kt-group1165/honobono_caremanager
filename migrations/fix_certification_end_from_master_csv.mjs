// ============================================================================
// 認定有効期間の終了日が壊れている認定レコードを、利用者マスタ CSV から直す。
//
// ── 何が起きたか ──────────────────────────────────────────────────────
//   MEISAI (稼働データ) からの STEP1 取込が、一部の利用者で
//   certification_end_date に誤った日付を入れていた。同じレコードの
//   service_limit_period_end (限度額適用期間) とは食い違っている。
//     例) 御山 真利子  認定 2023-12-01〜2026-06-30 / 限度額期間 〜2026-11-30
//   伝送 8124 の項15 (認定有効期間終了年月日) に出るため、居宅の突合で
//   1 件だけ DIFF になって見つかった (2026-08-20 四街道)。
//
// ── 正解の出どころ ────────────────────────────────────────────────────
//   利用者データ/**/介護保険*.CSV (ほのぼのの**利用者マスタ**)。
//   請求データではないので、ここから直しても突合は循環しない。
//     col  4 被保険者番号
//     col 11 要介護状態区分
//     col 13 認定有効期間 開始
//     col 14 認定有効期間 終了
//     col 15 限度額適用期間 開始
//     col 16 限度額適用期間 終了
//     col 17 区分支給限度基準額
//
//   ⚠ 1 人に複数行 (更新申請) があるので、**対象月を含む認定**を採る。
//     該当が複数なら開始日が新しいほうを採る。
//
//   node migrations/fix_certification_end_from_master_csv.mjs            # DRY RUN
//   node migrations/fix_certification_end_from_master_csv.mjs --execute
//   MONTH=2026-06 で対象月を変更
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";

const EXECUTE = process.argv.includes("--execute");
const MONTH = process.env.MONTH || "2026-06";
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const MONTH_START = `${MONTH}-01`;
const MONTH_END = new Date(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5, 7)), 0)
  .toISOString().slice(0, 10);

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

/** "2026/11/30" → "2026-11-30" (空は null) */
const toIso = (s) => {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((s ?? "").trim());
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
};

/** 利用者データ/ 配下の 介護保険*.CSV を再帰で集める */
function findMasterCsvs() {
  const base = path.join(KAIGO, "利用者データ");
  const out = [];
  const walk = (d, depth) => {
    if (depth > 3 || !existsSync(d)) return;
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (/^介護保険.*\.CSV$/i.test(n) && st.size > 0) out.push(p);
    }
  };
  walk(base, 0);
  return out;
}

function parseMaster() {
  // 被保番 → [{start, end, careLevel, limitAmount, src}]
  const by = new Map();
  for (const f of findMasterCsvs()) {
    const text = iconv.decode(readFileSync(f), "Shift_JIS");
    for (const line of text.split(/\r?\n/)) {
      const c = line.split(",").map((s) => s.replace(/^"|"$/g, "").trim());
      if (c.length < 17) continue;
      const insured = c[4];
      if (!/^\d{10}$/.test(insured)) continue;
      const start = toIso(c[13]);
      const end = toIso(c[14]);
      if (!start || !end) continue;
      if (!by.has(insured)) by.set(insured, []);
      by.get(insured).push({
        start, end, careLevel: c[11] || null,
        limitAmount: /^\d+$/.test(c[17]) ? Number(c[17]) : null,
        src: path.basename(f),
      });
    }
  }
  return by;
}

async function main() {
  console.log(`=== 認定有効期間の是正 ${MONTH} ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const master = parseMaster();
  console.log(`  利用者マスタ CSV から ${master.size} 名分の認定を読込\n`);

  // 認定終了日と限度額期間終了日が食い違うレコードだけを対象にする
  let all = [], from = 0;
  for (;;) {
    const { data, error } = await sb
      .from("client_insurance_records")
      .select("id, insured_number, care_level, certification_start_date, certification_end_date, service_limit_period_end, notes, clients(name)")
      .order("id").range(from, from + 999);
    if (error) { console.error(`✗ 取得失敗: ${error.message}`); process.exit(1); }
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  const suspect = all.filter(
    (r) => r.certification_end_date && r.service_limit_period_end &&
      r.certification_end_date !== r.service_limit_period_end,
  );
  console.log(`  認定終了日 ≠ 限度額期間終了日: ${suspect.length} 件\n`);

  const plan = [], unresolved = [];
  for (const r of suspect) {
    const rows = master.get(r.insured_number) ?? [];
    // 対象月を含む認定を採る。複数なら開始日が新しいほう
    const hit = rows
      .filter((x) => x.start <= MONTH_END && x.end >= MONTH_START)
      .sort((a, b) => b.start.localeCompare(a.start))[0];
    if (!hit) {
      unresolved.push(`${r.clients?.name ?? "?"} (${r.insured_number}): マスタ CSV に ${MONTH} を含む認定が無い`);
      continue;
    }
    const changes = {};
    if (hit.end !== r.certification_end_date) changes.certification_end_date = hit.end;
    if (hit.start !== r.certification_start_date) changes.certification_start_date = hit.start;
    if (!Object.keys(changes).length) continue;
    plan.push({ r, hit, changes });
  }

  for (const p of plan) {
    console.log(`  ${(p.r.clients?.name ?? "?").padEnd(12)} ${p.r.insured_number}`);
    for (const [k, v] of Object.entries(p.changes)) {
      console.log(`      ${k}: ${p.r[k] ?? "(空)"} → ${v}   [出典 ${p.hit.src}]`);
    }
  }
  if (unresolved.length) {
    console.log(`\n  -- マスタで確定できず ${unresolved.length} 件 (手当てが必要) --`);
    for (const u of unresolved) console.log(`     ${u}`);
  }
  console.log(`\n  是正対象 ${plan.length} 件`);

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で更新します。"); return; }

  for (const p of plan) {
    const { error } = await sb
      .from("client_insurance_records")
      .update({ ...p.changes, updated_at: new Date().toISOString() })
      .eq("id", p.r.id);
    if (error) { console.error(`✗ 更新失敗 (${p.r.clients?.name}): ${error.message}`); process.exit(1); }
    console.log(`  ✓ ${p.r.clients?.name}`);
  }
  console.log(`\n✓ ${plan.length} 件を更新しました`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
