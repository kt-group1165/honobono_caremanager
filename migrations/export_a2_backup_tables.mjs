// ============================================================================
// Phase A2 / dedup バックアップ表を JSON に書き出す (DB は読むだけ)
//
// 2026-09-01 監査是正の後始末。
//   バックアップ表は `CREATE TABLE AS` で作られていて RLS が無効 = anon に全公開
//   だった (銀行口座 9,428 件を含む)。RLS で塞いだうえで、役目を終えたものは
//   DB から落として負債を減らす。
//
//   ただし「バックアップにしか無い行」があるものは消す前にファイル化する。
//   実測 (2026-09-01):
//     payroll_* 系 5 表 (11,449 行)   … 消失 0 = 完全な重複 → 書き出し不要・そのまま DROP
//     _backup_clients_dedup_20260602  … 1,516 行中 806 行がライブに無い
//     _backup_clients_anesaki_20260602… 1,065 行中   9 行
//     _backup_clients_phone_20260602  …   659 行中  20 行
//     tenants_backup_a2_20260507      …    11 行中   5 行 (care-chiba 等の旧テナント)
//
//   806 行は重複統合 (merge_duplicate_clients) で物理的に統合された側。
//   このプロジェクトは統合の事故が繰り返し起きている (石井洋子・本多ふじ江 /
//   豊田浩行・元吉敏枝 / 山田綾子)。「統合が誤りだった」と後で分かったとき、
//   統合前の姿が残っているのはこの行だけなので捨てない。
//
//   node migrations/export_a2_backup_tables.mjs
//     → migrations/_backup_a2_export_YYYYMMDD/<table>.json を書き出す
//     → DB には一切書き込まない
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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

// 書き出す = バックアップにしか無い行があるもの
const TABLES = [
  "_backup_clients_dedup_20260602",
  "_backup_clients_anesaki_20260602",
  "_backup_clients_phone_20260602",
  "tenants_backup_a2_20260507",
];

const PAGE = 1000;

async function fetchAll(table) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from(table)
      .select("*")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} の取得に失敗: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return out;
  }
}

async function main() {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const dir = path.join(KAIGO, "migrations", `_backup_a2_export_${stamp}`);
  mkdirSync(dir, { recursive: true });
  console.log(`=== Phase A2 バックアップ表の書き出し (DB は読むだけ) ===`);
  console.log(`    出力先: ${dir}\n`);

  let total = 0;
  for (const t of TABLES) {
    let rows;
    try {
      rows = await fetchAll(t);
    } catch (e) {
      console.error(`  ✗ ${t}: ${e.message}`);
      process.exitCode = 1;
      continue;
    }
    const file = path.join(dir, `${t}.json`);
    writeFileSync(file, JSON.stringify(rows, null, 2), "utf8");
    total += rows.length;
    console.log(`  ✓ ${t.padEnd(34)} ${String(rows.length).padStart(6)} 行 → ${path.basename(file)}`);
  }
  console.log(`\n合計 ${total} 行を書き出しました。`);
  console.log(`確認したら DROP してよい (SQL は監査レポート / WORKING_NOW を参照)。`);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
