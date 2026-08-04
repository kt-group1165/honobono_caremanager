// ============================================================================
// 大網 2147483647(ゴミ利用者番号)client の混線是正
//   大網の利用者番号2147483647は8人が共有。STEP1は1clientに潰し、name=吉田律子/
//   被保番=鈴鹿絹子(0000040279)/保険者124248/要介護5 の混線状態で作成していた。
//   6月に介護実績(稼働19行=78,280)があるのは蛭田康子(被保番0100798182)のみ
//   (ほのぼの伝送KK260701で確認)。→ このclientを蛭田康子の正データに訂正する。
//   実績(visit_schedule)は既にこのclient_idに紐付いており移動不要(=蛭田の実績)。
//
//   node migrations/fix_oami_2147483647_hiruta.mjs            # DRY RUN
//   node migrations/fix_oami_2147483647_hiruta.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
function loadEnv() { const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8"); const e = {}; for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, ""); } return e; }
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// 蛭田康子の正データ (大網 基本情報 + 介護保険1 CSV より)
const H = {
  name: "蛭田 康子",
  birth_date: "1946-03-15",
  gender: "女",
  insured_number: "0100798182",
  insurer_number: "122135",
  care_level: "要介護3",
  certification_status: "認定済み",
  cert_start: "2024-09-01",
  cert_end: "2028-08-31",
  copay_rate: "1", // 給付率90
};

async function main() {
  console.log(`=== 大網2147483647 蛭田康子 訂正 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);
  const map = JSON.parse(readFileSync(path.join(KAIGO, "migrations/_meisai_num_to_client_大網.json"), "utf8"));
  const cid = map["2147483647"];
  if (!cid) throw new Error("2147483647 マッピング無し");

  const { data: cur } = await sb.from("clients").select("name,insured_number,care_level").eq("id", cid).single();
  console.log(`対象client ${cid}`);
  console.log(`  現状: ${cur.name} / 被保番${cur.insured_number} / ${cur.care_level}`);
  console.log(`  訂正後: ${H.name} / 被保番${H.insured_number} / ${H.care_level} / 保険者${H.insurer_number}`);

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で clients + client_insurance_records を訂正。"); return; }

  const { error: e1 } = await sb.from("clients").update({
    name: H.name, birth_date: H.birth_date, gender: H.gender,
    insured_number: H.insured_number, insurer_number: H.insurer_number,
    care_level: H.care_level, copay_rate: H.copay_rate,
    certification_start_date: H.cert_start, certification_end_date: H.cert_end,
  }).eq("id", cid);
  if (e1) { console.error(`✗ clients更新: ${e1.message}`); process.exit(1); }

  const { error: e2, count } = await sb.from("client_insurance_records").update({
    insured_number: H.insured_number, insurer_number: H.insurer_number,
    care_level: H.care_level, certification_status: H.certification_status,
    certification_start_date: H.cert_start, certification_end_date: H.cert_end,
    copay_rate: H.copay_rate,
  }, { count: "exact" }).eq("client_id", cid).like("notes", "%大網%");
  if (e2) { console.error(`✗ insurance更新: ${e2.message}`); process.exit(1); }
  console.log(`✓ 完了: clients 1件 + insurance ${count}件 訂正`);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
