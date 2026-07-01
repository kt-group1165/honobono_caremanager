// fake 契約書 10 件の office_id を訪問介護 → 居宅介護支援 (Hana 居宅支援センターおゆみ野) に差し替え
// dry-run 標準、--execute で実書換
import { createClient } from "@supabase/supabase-js";
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error("env missing"); process.exit(1); }
const sb = createClient(SB_URL, SB_KEY);

const OLD_OFFICE_ID = "4f14d50c-76b5-4f44-ac41-ed6d01f53a30"; // Ｈａｎａヘルパーステーションおゆみ野 (訪問介護)
const NEW_OFFICE_ID = "1b22d425-2ec4-4c2f-a002-c1c994e94507"; // Ｈａｎａ居宅支援センターおゆみ野 (居宅介護支援)
const EXECUTE = process.argv.includes("--execute");

// NEW_OFFICE_ID の実体確認
const { data: newOffice, error: e1 } = await sb.from("offices")
  .select("id, name, service_type").eq("id", NEW_OFFICE_ID).maybeSingle();
if (e1 || !newOffice) {
  console.error(`❌ NEW_OFFICE_ID=${NEW_OFFICE_ID} が offices に存在しない`);
  process.exit(1);
}
console.log(`✅ 新 office: ${newOffice.name} (${newOffice.service_type}) id=${NEW_OFFICE_ID}`);
if (newOffice.service_type !== "居宅介護支援") {
  console.error(`❌ 新 office の service_type が居宅介護支援でない (=${newOffice.service_type})`);
  process.exit(1);
}

// 対象契約: notes に fake マーカー + 旧 office_id
const { data: rows, error: e2 } = await sb.from("kaigo_user_contracts")
  .select("id, user_id, office_id, business_type, contract_type")
  .like("notes", "%fake%")
  .eq("office_id", OLD_OFFICE_ID);
if (e2) { console.error(e2); process.exit(1); }
console.log(`\n対象契約: ${rows.length} 件`);
rows.slice(0, 3).forEach(r => console.log(`  ${r.id.slice(0,8)}...  business_type=${r.business_type}`));
if (rows.length === 0) { console.log("対象なし。終了"); process.exit(0); }

if (!EXECUTE) {
  console.log("\n🔍 DRY RUN — --execute で実書換");
  process.exit(0);
}

const ids = rows.map(r => r.id);
const { error: eUp, count } = await sb.from("kaigo_user_contracts")
  .update({ office_id: NEW_OFFICE_ID }, { count: "exact" })
  .in("id", ids);
if (eUp) { console.error("UPDATE 失敗:", eUp.message); process.exit(1); }
console.log(`✅ UPDATE 完了: ${count} 件`);
