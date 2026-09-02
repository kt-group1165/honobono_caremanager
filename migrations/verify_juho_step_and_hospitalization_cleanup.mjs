// ============================================================================
// verify_juho_step_and_hospitalization.mjs --execute が作ったテストデータの後始末。
//
//   対象: user_number = 'JUHOTST1' (tenant_id='kt-group') の clients と、
//   それに紐づく client_office_assignments / client_insurance_records /
//   client_kohi_records / shougai_certifications / shogai_contracts /
//   client_hospitalizations / kaigo_visit_schedule のみ。
//
//   ⚠ 安全策: user_number が 'JUHOTST1' に厳密一致する client_id 以外は
//   一切削除しない (他の fake データ・本番データを巻き込まない)。
//
//   使い方:
//     node migrations/verify_juho_step_and_hospitalization_cleanup.mjs            # DRY RUN
//     node migrations/verify_juho_step_and_hospitalization_cleanup.mjs --execute  # 実削除
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const TENANT_ID = "kt-group";
const USER_NO = "JUHOTST1";
const MARK = "[fake テスト用-juho-20260903]";

function loadEnv() {
  const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function main() {
  console.log(`=== juho 検証テストデータ 削除 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const { data: client, error: clErr } = await sb
    .from("clients").select("id,name,user_number,tenant_id")
    .eq("user_number", USER_NO).eq("tenant_id", TENANT_ID).maybeSingle();
  if (clErr) { console.error(`✗ clients 取得失敗: ${clErr.message}`); process.exit(1); }
  if (!client) {
    console.log(`user_number=${USER_NO} の client が見つかりません。削除対象なし (既に片付いています)。`);
    return;
  }
  console.log(`対象: ${client.name} (${client.user_number} / ${client.id})\n`);
  const cid = client.id;

  const steps = [];
  const add = (label, run) => steps.push({ label, run });

  add("kaigo_visit_schedule (notes marker)", (del) =>
    del ? sb.from("kaigo_visit_schedule").delete().eq("user_id", cid).like("notes", `${MARK}%`)
        : sb.from("kaigo_visit_schedule").select("id", { count: "exact", head: true }).eq("user_id", cid).like("notes", `${MARK}%`));
  add("client_hospitalizations", (del) =>
    del ? sb.from("client_hospitalizations").delete().eq("client_id", cid)
        : sb.from("client_hospitalizations").select("id", { count: "exact", head: true }).eq("client_id", cid));
  add("shogai_contracts", (del) =>
    del ? sb.from("shogai_contracts").delete().eq("client_id", cid)
        : sb.from("shogai_contracts").select("id", { count: "exact", head: true }).eq("client_id", cid));
  add("shougai_certifications", (del) =>
    del ? sb.from("shougai_certifications").delete().eq("client_id", cid)
        : sb.from("shougai_certifications").select("id", { count: "exact", head: true }).eq("client_id", cid));
  add("client_kohi_records", (del) =>
    del ? sb.from("client_kohi_records").delete().eq("client_id", cid)
        : sb.from("client_kohi_records").select("id", { count: "exact", head: true }).eq("client_id", cid));
  add("client_insurance_records", (del) =>
    del ? sb.from("client_insurance_records").delete().eq("client_id", cid)
        : sb.from("client_insurance_records").select("id", { count: "exact", head: true }).eq("client_id", cid));
  add("client_office_assignments", (del) =>
    del ? sb.from("client_office_assignments").delete().eq("client_id", cid)
        : sb.from("client_office_assignments").select("client_id", { count: "exact", head: true }).eq("client_id", cid));

  console.log("=== 削除計画 ===");
  for (const s of steps) {
    const { count, error } = await s.run(false);
    if (error) { console.log(`  ${s.label.padEnd(30)} (取得失敗: ${error.message})`); continue; }
    console.log(`  ${s.label.padEnd(30)} ${count ?? 0} 行`);
  }
  console.log(`  clients                        1 行 (${client.user_number})`);

  if (!EXECUTE) {
    console.log("\n※ DRY RUN。--execute で削除します。");
    return;
  }

  console.log("\n=== 削除実行 ===");
  for (const s of steps) {
    const { error } = await s.run(true);
    if (error) { console.error(`✗ ${s.label}: ${error.message}`); process.exit(1); }
    console.log(`  ✓ ${s.label}`);
  }
  const { error: cErr } = await sb.from("clients").delete().eq("id", cid);
  if (cErr) { console.error(`✗ clients: ${cErr.message}`); process.exit(1); }
  console.log(`  ✓ clients (${client.user_number})`);

  console.log("\n✓ 完了。テストデータを全て削除しました。");
}

main().catch((e) => { console.error("ERROR:", e.stack || e.message); process.exit(1); });
