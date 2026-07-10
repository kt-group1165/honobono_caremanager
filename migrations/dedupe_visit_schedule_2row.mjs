// 提供表の旧2行保存 (scheduled+completed) の重複解消 (dry-run 付き)
//   node migrations/dedupe_visit_schedule_2row.mjs            # DRY RUN
//   node migrations/dedupe_visit_schedule_2row.mjs --execute  # 本番
//
// 背景 (監査#8): 旧提供表は「予定+実績」セルを scheduled+completed の2行で保存していた。
// 1行=1訪問 (statusで予実) に統一したため、既存の
//   同一 (user_id, visit_date, start_time, end_time, service_type, office_id) で
//   completed 行が存在する scheduled 行 = 旧2行式の予定側
// を削除する (completed 側が「予定どおり実施」を表す)。
//
// 削除前に対象一覧を _backup_visit_schedule_dedupe_<date>.json に保存する。

import { readFileSync, writeFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const env = readFileSync(new URL("../.env.local", import.meta.url), "utf-8");
const SB_URL = /NEXT_PUBLIC_SUPABASE_URL=(\S+)/.exec(env)[1].trim();
const KEY = /SUPABASE_SERVICE_ROLE_KEY=(\S+)/.exec(env)[1].trim();
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function rest(path, opts = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${path} :: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const key = (r) =>
  [r.user_id, r.visit_date, r.start_time ?? "", r.end_time ?? "", r.service_type ?? "", r.office_id ?? ""].join("|");

const main = async () => {
  // 全件 page-loop (id 順)
  const all = [];
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    const page = await rest(
      `kaigo_visit_schedule?select=id,user_id,visit_date,start_time,end_time,service_type,status,office_id&order=id&limit=${PAGE}&offset=${offset}`,
    );
    all.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  console.log(`kaigo_visit_schedule 全 ${all.length} 行`);

  const completedKeys = new Set(all.filter((r) => r.status === "completed").map(key));
  const dupScheduled = all.filter(
    (r) => (r.status === "scheduled" || r.status === "changed") && completedKeys.has(key(r)),
  );
  console.log(`旧2行式の重複 scheduled 行: ${dupScheduled.length} 件`);
  if (dupScheduled.length === 0) return;

  // 内訳 (月別)
  const byMonth = new Map();
  for (const r of dupScheduled) {
    const m = r.visit_date.slice(0, 7);
    byMonth.set(m, (byMonth.get(m) ?? 0) + 1);
  }
  for (const [m, n] of [...byMonth.entries()].sort()) console.log(`  ${m}: ${n} 件`);

  if (!EXECUTE) {
    console.log("\n[DRY RUN] 削除していません。--execute で削除 (backup json を残します)。");
    return;
  }

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const backupPath = new URL(`./_backup_visit_schedule_dedupe_${stamp}.json`, import.meta.url);
  writeFileSync(backupPath, JSON.stringify(dupScheduled, null, 1));
  console.log(`backup: ${backupPath.pathname}`);

  // 100 件ずつ削除
  let deleted = 0;
  for (let i = 0; i < dupScheduled.length; i += 100) {
    const ids = dupScheduled.slice(i, i + 100).map((r) => r.id);
    await rest(`kaigo_visit_schedule?id=in.(${ids.join(",")})`, { method: "DELETE" });
    deleted += ids.length;
  }
  console.log(`[OK] ${deleted} 件の重複 scheduled 行を削除しました。`);
};

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
