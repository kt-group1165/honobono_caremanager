// ============================================================================
// _densou_intentional_diff.json の「意図的に伝送と揃えない」値を DB に反映する。
//
//   ほのぼのの伝送は原則として正だが、ほのぼの側の算定漏れ・設定漏れが
//   **user の確認で確定した** ものは当方を正しい値にする。台帳に載せておくと
//   伝送取込 (import_kyotaku_claims_from_kk.mjs) が上書きし返さない。
//
//   node migrations/apply_densou_intentional_diff.mjs             # DRY RUN
//   node migrations/apply_densou_intentional_diff.mjs --execute
//   env: MONTH=2026-06 (省略時は台帳の全件)
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const MONTH = process.env.MONTH || null;
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

async function main() {
  const ledger = JSON.parse(
    readFileSync(path.join(KAIGO, "migrations", "_densou_intentional_diff.json"), "utf8"),
  );
  const entries = (ledger.entries ?? []).filter((e) => !MONTH || e.month === MONTH);
  console.log(`=== 意図的不一致の反映 ${MONTH ?? "全件"} ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);
  console.log(`  台帳 ${entries.length} 件\n`);

  for (const e of entries) {
    if (!e.table || !e.set) { console.log(`  ⚠ ${e.name}: table / set が無く反映できない`); continue; }

    const { data: ins, error: e1 } = await sb.from("client_insurance_records")
      .select("client_id, clients(name)").eq("insured_number", e.insured_number)
      .eq("insurer_number", e.insurer_number);
    if (e1) { console.error(`✗ ${e1.message}`); process.exit(1); }
    const cids = [...new Set((ins ?? []).map((r) => r.client_id))];
    if (cids.length !== 1) { console.log(`  ⚠ ${e.name}: 被保番 ${e.insured_number} の利用者が ${cids.length} 名`); continue; }

    const { data: cur, error: e2 } = await sb.from(e.table)
      .select("*").eq("user_id", cids[0]).eq("billing_month", e.month);
    if (e2) { console.error(`✗ ${e2.message}`); process.exit(1); }
    const row = (cur ?? [])[0];
    if (!row) { console.log(`  ⚠ ${e.name}: ${e.month} のレコードが無い`); continue; }

    const diffs = Object.entries(e.set)
      .filter(([k, v]) => String(row[k] ?? "") !== String(v ?? ""))
      .map(([k, v]) => `${k}: ${row[k] ?? "(空)"} → ${v}`);

    console.log(`  ${e.name} (${e.office})  差 ${e.diff_amount?.toLocaleString() ?? "?"}円`);
    console.log(`     ${e.reason}`);
    if (!diffs.length) { console.log(`     → 反映済み`); continue; }
    for (const d of diffs) console.log(`     ${d}`);

    if (EXECUTE) {
      const { error: e3 } = await sb.from(e.table)
        .update({ ...e.set, updated_at: new Date().toISOString(),
          notes: `[意図的不一致 ${e.month}] ${e.reason}` })
        .eq("id", row.id);
      if (e3) { console.error(`✗ ${e.name}: ${e3.message}`); process.exit(1); }
      console.log(`     ✓ 反映`);
    }
  }
  if (!EXECUTE) console.log("\n※ DRY RUN。--execute で反映します。");
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
