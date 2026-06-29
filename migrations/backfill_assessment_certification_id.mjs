// 既存 kaigo_assessments で certification_id = NULL の行に、
// その user の最新 client_insurance_records.id を埋める。
//
// 経緯: 旧 enrich_houmonkaigo_sample_data.mjs が certification_id を未設定で投入していて、
//       UI の /assessments page が cert filter で除外してしまっていた。
//
// Usage:
//   node migrations/backfill_assessment_certification_id.mjs            # DRY RUN
//   node migrations/backfill_assessment_certification_id.mjs --execute  # 本番

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(resolve(__dirname, "..", ".env.local"), "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter(l => l && !l.startsWith("#") && l.includes("=")).map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const EXECUTE = process.argv.includes("--execute");
console.log(`[mode] ${EXECUTE ? "EXECUTE" : "DRY-RUN"}\n`);

// certification_id = NULL の assessments を全件取得 (page-loop)
const PAGE = 1000;
const targets = [];
let from = 0;
while (true) {
  const { data, error } = await sb.from("kaigo_assessments")
    .select("id, user_id")
    .is("certification_id", null)
    .range(from, from + PAGE - 1);
  if (error) { console.error("fetch:", error.message); process.exit(1); }
  if (!data || data.length === 0) break;
  targets.push(...data);
  if (data.length < PAGE) break;
  from += PAGE;
}
console.log(`[1] certification_id = NULL の assess: ${targets.length} 件`);

// user 別にグルーピング
const byUser = new Map();
for (const t of targets) {
  if (!byUser.has(t.user_id)) byUser.set(t.user_id, []);
  byUser.get(t.user_id).push(t.id);
}
console.log(`[2] 対象 user: ${byUser.size} 名`);

// 各 user の最新 cert を取得 + UPDATE
let updated = 0;
let skipped = 0;
for (const [userId, assessIds] of byUser) {
  const { data: certs } = await sb.from("client_insurance_records")
    .select("id, certification_start_date")
    .eq("client_id", userId)
    .order("certification_start_date", { ascending: false, nullsFirst: false })
    .limit(1);
  const certId = certs?.[0]?.id;
  if (!certId) {
    skipped += assessIds.length;
    console.log(`  skip: user ${userId.slice(0, 8)}.. (cert なし、${assessIds.length} 件)`);
    continue;
  }
  if (EXECUTE) {
    const { error } = await sb.from("kaigo_assessments")
      .update({ certification_id: certId })
      .in("id", assessIds);
    if (error) { console.error(`  ${userId.slice(0,8)} UPDATE:`, error.message); continue; }
  }
  updated += assessIds.length;
}

console.log(`\n[3] 結果: ${updated} 件 ${EXECUTE ? "UPDATE 完了" : "(dry-run 想定)"}、skip ${skipped} 件`);
if (!EXECUTE) console.log("\n--execute で本番。");
