// 既存 kaigo_visit_procedure_steps の (content, detail) を一意化して
// kaigo_visit_procedure_step_templates に登録する one-shot script。
//
// Usage:
//   node migrations/register_seed_steps_as_templates.mjs              # DRY RUN
//   node migrations/register_seed_steps_as_templates.mjs --execute    # 本番 INSERT
//
// office_id: Hanaヘルパーステーション花見川 (= seed の対象 office)

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env.local");
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const sb = createClient(SB_URL, SB_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const EXECUTE = process.argv.includes("--execute");
const MODE = EXECUTE ? "EXECUTE" : "DRY-RUN";
const HANA_OFFICE_ID = "4f14d50c-76b5-4f44-ac41-ed6d01f53a30"; // Hanaヘルパーステーション花見川
const TENANT_ID = "kt-group";

console.log(`[mode] ${MODE}`);
console.log(`[office] Hanaヘルパー (${HANA_OFFICE_ID})\n`);

// 1) 既存 steps を全件取得 (PostgREST 1000 行 limit を page-loop で回避)
const PAGE = 1000;
const allSteps = [];
let from = 0;
while (true) {
  const { data, error } = await sb
    .from("kaigo_visit_procedure_steps")
    .select("content, detail")
    .range(from, from + PAGE - 1);
  if (error) { console.error("steps fetch error:", error.message); process.exit(1); }
  if (!data || data.length === 0) break;
  allSteps.push(...data);
  if (data.length < PAGE) break;
  from += PAGE;
}
console.log(`[1] 既存 steps: ${allSteps.length} 行`);

// 2) name で dedup (= UNIQUE(office_id, name) 制約に合わせる)。
//    同名で detail が違う場合は「最長 detail」を採用 (= 最も情報量多い)。
const byName = new Map();
for (const s of allSteps) {
  const name = (s.content ?? "").trim();
  if (!name) continue;
  const detail = (s.detail ?? "").trim() || null;
  const cur = byName.get(name);
  if (!cur) { byName.set(name, { name, detail }); continue; }
  // detail が長い方を採用
  const curLen = (cur.detail ?? "").length;
  const newLen = (detail ?? "").length;
  if (newLen > curLen) byName.set(name, { name, detail });
}
const uniqueTemplates = [...byName.values()];
console.log(`[2] name 単位 dedup 後: ${uniqueTemplates.length} 件`);

// 3) 既存 templates と重複しないように事前 check
const { data: existing } = await sb
  .from("kaigo_visit_procedure_step_templates")
  .select("name")
  .eq("office_id", HANA_OFFICE_ID)
  .is("deleted_at", null);
const existingNames = new Set((existing ?? []).map((t) => t.name));
console.log(`[3] 既存 templates: ${existingNames.size} 件 (skip)`);

const newOnes = uniqueTemplates.filter((t) => !existingNames.has(t.name));
console.log(`[4] INSERT 対象: ${newOnes.length} 件\n`);

// 4) sample 出力 (先頭 10 件)
console.log("== sample (先頭 10 件) ==");
for (const t of newOnes.slice(0, 10)) {
  console.log(`  - "${t.name}" / detail: ${t.detail ? `"${t.detail.slice(0, 40)}..."` : "(なし)"}`);
}

if (newOnes.length === 0) {
  console.log("\n何もすることなし。");
  process.exit(0);
}

if (!EXECUTE) {
  console.log("\n本番投入は --execute を付けて再実行。");
  process.exit(0);
}

// 5) BULK INSERT
const inserts = newOnes.map((t, i) => ({
  office_id: HANA_OFFICE_ID,
  tenant_id: TENANT_ID,
  name: t.name,
  detail: t.detail,
  sort_order: i + 1,
}));
const { error: insErr } = await sb.from("kaigo_visit_procedure_step_templates").insert(inserts);
if (insErr) { console.error("INSERT error:", insErr.message); process.exit(1); }
console.log(`\n✓ ${inserts.length} 件 INSERT 完了`);
