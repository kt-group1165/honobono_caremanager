// 障害受給者証の誤紐付けを是正: 受給者番号 2000016879 (カンダユウスケ) が
// 別人 (上東野 真) に紐づいていた。
//
//   原因: 受給者証は PDF から名前ベースで clients に紐付ける運用のため、
//   clients に本人が存在しないと近い別人に付いてしまう
//   ([[project_honobono_shougai_import]] の「名前ベース紐付け必須」の弱点)。
//   稼働データの「神田　祐介（支）」(利用者番号916) は clients 未登録だった。
//   伝送 KJ260701 の J121 氏名カナが ｶﾝﾀﾞﾕｳｽｹ で、稼働データ側と一致する。
//
//   対応: 神田祐介の client を作成し、受給者証 2000016879 をそちらへ移す。
//   上東野真にはもう1枚 (2300007537 東金市) が正しく紐づいており、そちらは触らない。
//
//   node migrations/fix_shogai_cert_kanda.mjs [--execute]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
function loadEnv() { const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8"); const e = {}; for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, ""); } return e; }
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const BENEFICIARY = "2000016879";
const WRONG_CLIENT = "d9e001e2-a2af-49e3-952a-0e76f9671186"; // 上東野 真
const OFFICE_ID = "269d77bc-5b61-4114-a2ea-e8dc2f220823";    // リンクス大網白里
const NAME = "神田 祐介";
const FURIGANA = "カンダユウスケ";
const USER_NUMBER = "916"; // 稼働データの利用者番号

async function main() {
  console.log(`=== 受給者証 ${BENEFICIARY} の誤紐付け是正 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const { data: cert } = await sb.from("shougai_certifications")
    .select("id, client_id, insurer_municipality").eq("beneficiary_number", BENEFICIARY).maybeSingle();
  if (!cert) { console.error("受給者証が見つかりません"); process.exit(1); }
  if (cert.client_id !== WRONG_CLIENT) { console.log("既に別 client に紐づいています → 何もしません"); return; }

  // 既に神田の client が居ないか (再実行対策)
  const { data: exist } = await sb.from("clients").select("id, name").eq("user_number", USER_NUMBER).maybeSingle();
  console.log(`受給者証 ${BENEFICIARY} → 現在: 上東野 真 (誤り)`);
  console.log(`正: ${NAME} (稼働データ 利用者番号 ${USER_NUMBER} / 伝送カナ ｶﾝﾀﾞﾕｳｽｹ)`);
  console.log(exist ? `  既存 client あり: ${exist.name} (${exist.id})` : "  client 未登録 → 新規作成");

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で client 作成 + 受給者証の付替え + 事業所割当。"); return; }

  let clientId = exist?.id;
  if (!clientId) {
    const { data: created, error } = await sb.from("clients").insert({
      tenant_id: "kt-group", name: NAME, furigana: FURIGANA, user_number: USER_NUMBER,
      status: "active", is_provisional: false,
    }).select("id").single();
    if (error) { console.error("client 作成失敗:", error.message); process.exit(1); }
    clientId = created.id;
    console.log(`  ✓ client 作成: ${clientId}`);
  }

  const { error: e1 } = await sb.from("shougai_certifications").update({ client_id: clientId }).eq("id", cert.id);
  if (e1) { console.error("受給者証の付替え失敗:", e1.message); process.exit(1); }
  console.log("  ✓ 受給者証を付け替え");

  const { data: asg } = await sb.from("client_office_assignments")
    .select("id").eq("client_id", clientId).eq("office_id", OFFICE_ID).maybeSingle();
  if (!asg) {
    const { error: e2 } = await sb.from("client_office_assignments")
      .insert({ tenant_id: "kt-group", client_id: clientId, office_id: OFFICE_ID });
    if (e2) { console.error("事業所割当の作成失敗:", e2.message); process.exit(1); }
    console.log("  ✓ 事業所割当を作成");
  }
  console.log("\n完了。import_meisai_shougai_records.mjs を再実行すると 8 行が取り込まれます。");
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
