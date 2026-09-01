// ============================================================================
// enrich_fake_kyotaku_sample_data.mjs が投入した fake データの削除。
//   対象: おゆみ野の fake seed clients (A001-E010 + X001、user_number が
//   /^[ABCDEX]\d{3}$/ にマッチする46名。氏名は「佐藤 月遅」「瀬戸 過誤」等、
//   本プロジェクトの業務用語をもじった明らかな作り物で、実在利用者の氏名の
//   借用ではない。seed_fake_kyotaku_clients.mjs で作られた別人格の架空clients)。
//
//   本番テーブルへの混入が判明した2つの子テーブルだけを対象にする
//   (clients本体・client_office_assignments・client_insurance_records等は削除しない。
//    それらはfakeクライアントの実体そのものであり、別途方針決定が要る)。
//
//   kaigo_support_records  … content LIKE '%[fake テスト用-kyotaku-enrich]%'  322件
//   kaigo_assessments      … overall_summary LIKE '%[fake テスト用]%' かつ
//                             form_data->>'_fake' = 'true'                     46件
//
//   2026-09-01 事前確認 (READ ONLY):
//   - マーカー付きレコードは100%上記46名のfakeクライアントに紐付き、実在
//     クライアントへの誤爆は0件 (逆方向: fakeクライアントにマーカー無しの
//     レコードが紛れている件も0件)
//   - 他テーブルからこの2テーブルへのFK参照なし (leaf table)
//   - 集計・請求系画面はいずれも kaigo_care_support_claims 等の実請求データを
//     起点にID集合を作るため、fakeクライアント(実請求0件)はそもそも対象に
//     入らない設計。運営基準タブ等の統計値への影響は無し
//   - バックアップ済み: migrations/_backup_fake_kyotaku_enrich_support_records_20260901.json (322件)
//                       migrations/_backup_fake_kyotaku_enrich_assessments_20260901.json (46件)
//
//   node migrations/fix_fake_kyotaku_enrich_data.mjs            # DRY RUN
//   node migrations/fix_fake_kyotaku_enrich_data.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function main() {
  console.log(`=== fake kyotaku-enrich データ削除 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const { data: sr, error: srErr } = await sb
    .from("kaigo_support_records")
    .select("id,user_id,content")
    .ilike("content", "%kyotaku-enrich%");
  if (srErr) { console.error("✗ support_records 取得失敗:", srErr.message); process.exit(1); }

  const { data: asm, error: asmErr } = await sb
    .from("kaigo_assessments")
    .select("id,user_id,overall_summary")
    .ilike("overall_summary", "%fake テスト用%");
  if (asmErr) { console.error("✗ assessments 取得失敗:", asmErr.message); process.exit(1); }

  console.log(`kaigo_support_records 削除対象: ${sr.length}件`);
  console.log(`kaigo_assessments     削除対象: ${asm.length}件`);

  if (!EXECUTE) {
    console.log("\n※ DRY RUN。--execute で削除実行 (バックアップは既に取得済み)。");
    return;
  }

  const srIds = sr.map((r) => r.id);
  const asmIds = asm.map((r) => r.id);
  let srDeleted = 0, asmDeleted = 0;
  for (let i = 0; i < srIds.length; i += 200) {
    const chunk = srIds.slice(i, i + 200);
    const { error, count } = await sb.from("kaigo_support_records").delete({ count: "exact" }).in("id", chunk);
    if (error) { console.error("✗ support_records 削除失敗:", error.message); process.exit(1); }
    srDeleted += count ?? 0;
  }
  for (let i = 0; i < asmIds.length; i += 200) {
    const chunk = asmIds.slice(i, i + 200);
    const { error, count } = await sb.from("kaigo_assessments").delete({ count: "exact" }).in("id", chunk);
    if (error) { console.error("✗ assessments 削除失敗:", error.message); process.exit(1); }
    asmDeleted += count ?? 0;
  }
  console.log(`\n✓ 完了: support_records ${srDeleted}件 / assessments ${asmDeleted}件 削除`);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
