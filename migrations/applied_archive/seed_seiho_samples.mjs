// テスト利用者に生活保護の 2 パターンを設定する (動作確認用サンプル)
//   パターン1 (保険優先): 山下静枝 (0006000005) — 通常の被保険者 + 法別12
//     → 保険9割 + 本人1割分を公費請求へ振替
//   パターン2 (公費単独): 森隆一 (0006000006) — 被保険者番号を 'H' 番号に変更 + 法別12
//     → 保険給付なし、総費用10割を公費単独請求
// usage: node --env-file=.env.local migrations/seed_seiho_samples.mjs           # DRY RUN
//        node --env-file=.env.local migrations/seed_seiho_samples.mjs --execute
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json", Prefer: "return=representation" };
const EXECUTE = process.argv.includes("--execute");

// 公費 (生活保護): 負担者番号 12(法別) + 122016(千葉市の実施機関番号のサンプル)
const PATTERNS = [
  {
    insured: "0006000005", // 山下静枝
    label: "パターン1 (保険優先: 1割を公費振替)",
    patch: {
      kohi_hobetsu: "12",
      kohi_futansha_number: "12122016",
      kohi_jukyusha_number: "1234567",
      kohi_start_date: "2026-04-01",
      notes: "生活保護サンプル パターン1 (保険優先) [fake テスト用-seiho]",
    },
  },
  {
    insured: "0006000006", // 森隆一 → H 番号化
    label: "パターン2 (公費単独: H番号 10割公費)",
    patch: {
      insured_number: "H000000001",
      kohi_hobetsu: "12",
      kohi_futansha_number: "12122016",
      kohi_jukyusha_number: "7654321",
      kohi_start_date: "2026-04-01",
      notes: "生活保護サンプル パターン2 (公費単独/H番号) [fake テスト用-seiho]",
    },
  },
];

const main = async () => {
  for (const p of PATTERNS) {
    const rows = await fetch(
      `${SB_URL}/rest/v1/client_insurance_records?select=id,client_id,insured_number,kohi_hobetsu&insured_number=eq.${p.insured}`,
      { headers: H },
    ).then((r) => r.json());
    if (!Array.isArray(rows) || rows.length === 0) {
      console.log(`SKIP ${p.insured}: insurance record が見つからない (既に変更済み?)`);
      continue;
    }
    for (const row of rows) {
      console.log(`${EXECUTE ? "UPDATE" : "[dry] UPDATE"} ${p.insured} → ${p.label}`);
      console.log(`   patch:`, JSON.stringify(p.patch));
      if (EXECUTE) {
        const res = await fetch(`${SB_URL}/rest/v1/client_insurance_records?id=eq.${row.id}`, {
          method: "PATCH", headers: H, body: JSON.stringify(p.patch),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(`update failed: ${JSON.stringify(body)}`);
        console.log(`   -> updated ${Array.isArray(body) ? body.length : 0} rows`);
      }
    }
  }
  console.log(EXECUTE ? "done." : "DRY RUN (実行するには --execute)");
};
main().catch((e) => { console.error(e); process.exit(1); });
