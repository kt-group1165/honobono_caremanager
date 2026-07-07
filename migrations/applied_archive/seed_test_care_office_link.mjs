// テスト利用者 5 名 (Hana おゆみ野) に担当居宅 (care_offices) を紐付ける
// 目的: 月次情報/様式第二の「支援事業所番号・居宅介護支援事業所名」表示の動作確認
// usage: node migrations/seed_test_care_office_link.mjs           # DRY RUN
//        node migrations/seed_test_care_office_link.mjs --execute # 本番
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
const get = (k) => (env.match(new RegExp(k + "=(.+)")) || [])[1]?.trim();
const SB_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const KEY = get("SUPABASE_SERVICE_ROLE_KEY") || get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const H = { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json", Prefer: "return=representation" };

const EXECUTE = process.argv.includes("--execute");

// 被保険者番号 → 割り当てる care_offices (実在マスタから)
const ASSIGN = [
  { insured: "0006000008", officeName: "コスモス居宅支援センター" },        // 阿部
  { insured: "0006000007", officeName: "コスモス居宅支援センター" },        // 池田
  { insured: "0006000002", officeName: "ケイ・ティ・サービス居宅介護支援事業所" }, // 木村
  { insured: "0006000006", officeName: "ケイ・ティ・サービス居宅介護支援事業所" }, // 森
  { insured: "0006000005", officeName: "コスモス居宅支援センター" },        // 山下
];

const main = async () => {
  // care_offices を名前で引く
  const names = [...new Set(ASSIGN.map((a) => a.officeName))];
  const co = await fetch(
    `${SB_URL}/rest/v1/care_offices?select=id,name,office_number&name=in.(${names.map((n) => `"${n}"`).join(",")})`,
    { headers: H },
  ).then((r) => r.json());
  if (!Array.isArray(co) || co.length === 0) throw new Error("care_offices が引けません: " + JSON.stringify(co));
  const byName = new Map(co.map((o) => [o.name, o]));

  for (const a of ASSIGN) {
    const office = byName.get(a.officeName);
    if (!office) {
      console.log(`SKIP ${a.insured}: care_office "${a.officeName}" が見つからない`);
      continue;
    }
    console.log(`${EXECUTE ? "UPDATE" : "[dry] UPDATE"} insured=${a.insured} → care_office_id=${office.id} (${office.name} / ${office.office_number})`);
    if (EXECUTE) {
      const res = await fetch(
        `${SB_URL}/rest/v1/client_insurance_records?insured_number=eq.${a.insured}`,
        { method: "PATCH", headers: H, body: JSON.stringify({ care_office_id: office.id }) },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(`update failed ${a.insured}: ${JSON.stringify(body)}`);
      console.log(`  -> updated ${Array.isArray(body) ? body.length : 0} rows`);
    }
  }
  console.log(EXECUTE ? "done." : "DRY RUN (実行するには --execute)");
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
