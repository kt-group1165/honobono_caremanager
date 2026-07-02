// 単位数が引けないデータの削除 (2026-07-02)
// ---------------------------------------------------------------
// 月間個別 / 提供表で「単位数 —」になる行 = service_type が
// kaigo_service_codes (calculation_type=基本) に無い schedule を削除する。
// あわせて kaigo_visit_records (service_category='kaigo') の同条件行も削除。
// ※ shougai カテゴリの記録は対象外 (単位体系が別のため)
//
// usage:
//   node migrations/cleanup_no_unit_service_data.mjs            # DRY RUN
//   node migrations/cleanup_no_unit_service_data.mjs --execute  # 削除実行
//
// --execute 時は削除前に backup JSON を migrations/ 直下へ書き出す。
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("env NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が必要 (.env.local を source)");
  process.exit(1);
}
const sb = createClient(SB_URL, SB_KEY);

// UI (service-name-normalize.ts) と同じ正規化: 全角数字 → 半角
const toHankaku = (s) =>
  (s ?? "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

async function pageLoop(table, select, filter) {
  const PAGE = 1000;
  const rows = [];
  let from = 0;
  while (true) {
    let q = sb.from(table).select(select).range(from, from + PAGE - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} fetch 失敗: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

// 1) 基本コードの正規化 name set
const codes = await pageLoop("kaigo_service_codes", "service_name", (q) =>
  q.eq("calculation_type", "基本"),
);
const knownNames = new Set(codes.map((c) => toHankaku(c.service_name)));
console.log(`基本コード: ${codes.length} 件 (正規化後 ${knownNames.size} 名称)`);

// 2) schedule 全件 → 単位数が引けない service_type を抽出
const schedules = await pageLoop(
  "kaigo_visit_schedule",
  "id, user_id, visit_date, start_time, end_time, service_type, status",
);
const badSched = schedules.filter((s) => !knownNames.has(toHankaku(s.service_type ?? "")));

// 3) records も同条件で抽出
// (service_category 列は未適用のため無し。基本コードは全 system 分を
//  knownNames に含むので、障害系の正規名称は誤検出しない)
const records = await pageLoop(
  "kaigo_visit_records",
  "id, user_id, visit_date, start_time, service_type, status",
);
const badRec = records.filter((r) => !knownNames.has(toHankaku(r.service_type ?? "")));

// ---- レポート ----
const summarize = (rows) => {
  const byType = {};
  for (const r of rows) byType[r.service_type ?? "(null)"] = (byType[r.service_type ?? "(null)"] ?? 0) + 1;
  return byType;
};
console.log(`\nkaigo_visit_schedule: 全 ${schedules.length} 件中、単位数なし ${badSched.length} 件`);
for (const [t, n] of Object.entries(summarize(badSched)).sort((a, b) => b[1] - a[1])) {
  console.log(`  - "${t}": ${n} 件`);
}
console.log(`\nkaigo_visit_records: 全 ${records.length} 件中、単位数なし ${badRec.length} 件`);
for (const [t, n] of Object.entries(summarize(badRec)).sort((a, b) => b[1] - a[1])) {
  console.log(`  - "${t}": ${n} 件`);
}

if (!EXECUTE) {
  console.log("\n[DRY RUN] 削除していません。--execute で実行。");
  process.exit(0);
}

// ---- backup ----
const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const backupPath = fileURLToPath(new URL(`./_backup_no_unit_cleanup_${stamp}.json`, import.meta.url));
writeFileSync(backupPath, JSON.stringify({ badSched, badRec }, null, 1), "utf8");
console.log(`\nbackup 書出し: ${backupPath}`);

// ---- 削除 (chunk 100) ----
async function deleteByIds(table, rows) {
  let deleted = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const ids = rows.slice(i, i + 100).map((r) => r.id);
    const { error } = await sb.from(table).delete().in("id", ids);
    if (error) throw new Error(`${table} delete 失敗 (${i}〜): ${error.message}`);
    deleted += ids.length;
  }
  return deleted;
}
const dSched = await deleteByIds("kaigo_visit_schedule", badSched);
const dRec = await deleteByIds("kaigo_visit_records", badRec);
console.log(`\n削除完了: schedule ${dSched} 件 / records ${dRec} 件`);

// ---- 件数確認 (verify) ----
const after = await pageLoop("kaigo_visit_schedule", "id, service_type");
const remain = after.filter((s) => !knownNames.has(toHankaku(s.service_type ?? ""))).length;
console.log(`verify: schedule 残存 単位数なし = ${remain} 件 (0 であること) / 全体 ${after.length} 件`);
