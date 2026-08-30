// ============================================================================
// 2026-08-30 の受給者証取込で誤って入れた shougai_certifications.contract_start_date を戻す。
//
// ── なぜ ──────────────────────────────────────────────────────────────
//   aggregate.ts の初回加算 (居介 116020 / 重訪 126020 / 行動援護 136020) は
//   **contract_start_date の月 == 提供月** で判定する。
//   事業者記入欄 (SRD25) の「契約日」は *その事業所と契約した日* であって
//   「当該サービスの提供開始日」ではないため、そのまま入れると初回加算が誤発生する。
//
//   実害: 茂原で 磯野充幸 / 山田綾子 に 200単位 ずつ誤発生し、処遇改善(115175)も
//        連動して増えて、33/33 だった伝送突合が 31/33 に落ちた。
//
//   取込直前まで contract_start_date は **全件 null** だったので、
//   「今回入った分」= あの取込で入った分。null に戻す。
//
//   node migrations/revert_contract_start_date.mjs            # DRY RUN
//   node migrations/revert_contract_start_date.mjs --execute
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

async function main() {
  console.log(`=== contract_start_date を戻す ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  let rows = [], from = 0;
  for (;;) {
    const { data, error } = await sb.from("shougai_certifications")
      .select("id, beneficiary_number, contract_start_date, clients(name)")
      .not("contract_start_date", "is", null).range(from, from + 999);
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    rows = rows.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`  contract_start_date が入っている ${rows.length} 件`);

  // 初回加算が誤発生しうる = 2026-06 が契約月のもの
  const june = rows.filter((r) => String(r.contract_start_date).startsWith("2026-06"));
  console.log(`     うち 2026-06 が契約月 ${june.length} 件 (初回加算が誤発生する)`);
  for (const r of june.slice(0, 20)) {
    console.log(`     ${(r.clients?.name ?? "?").padEnd(14)} [${r.beneficiary_number}] ${r.contract_start_date}`);
  }
  if (june.length > 20) console.log(`     … 他 ${june.length - 20} 件`);

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で null に戻します。"); return; }

  let n = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { error } = await sb.from("shougai_certifications")
      .update({ contract_start_date: null, updated_at: new Date().toISOString() })
      .in("id", chunk.map((r) => r.id));
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    n += chunk.length;
  }
  console.log(`\n✓ ${n} 件の contract_start_date を null に戻しました`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
