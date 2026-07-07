// 訪問介護 (11) の処遇改善加算 R8/6 行に告示率の formula を設定する
// (R8/6 で Ⅰ→Ⅰ1/Ⅰ2、Ⅱ→Ⅱ1/Ⅱ2 に再編。率はコード毎に告示で確定)
// usage: node --env-file=.env.local migrations/update_r8_06_shoguu_formula_kaigo11.mjs           # DRY RUN
//        node --env-file=.env.local migrations/update_r8_06_shoguu_formula_kaigo11.mjs --execute
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json", Prefer: "return=representation" };
const EXECUTE = process.argv.includes("--execute");

// R8/6 告示率 (訪問介護)。formula = { type: 'monthly_aggregate', numerator, denominator }
const RATES = [
  { code: "116275", label: "処遇改善加算Ⅰ1", num: 270 },
  { code: "116183", label: "処遇改善加算Ⅰ2", num: 287 },
  { code: "116274", label: "処遇改善加算Ⅱ1", num: 249 },
  { code: "116184", label: "処遇改善加算Ⅱ2", num: 266 },
  { code: "116271", label: "処遇改善加算Ⅲ", num: 207 },
  { code: "116380", label: "処遇改善加算Ⅳ", num: 170 },
];

const main = async () => {
  for (const r of RATES) {
    // R8/6 行 (valid_from=2026-06-01) のみ対象
    const rows = await fetch(
      `${SB_URL}/rest/v1/kaigo_service_codes?select=id,service_name,formula&system=eq.介護&service_code=eq.${r.code}&valid_from=eq.2026-06-01`,
      { headers: H },
    ).then((x) => x.json());
    if (!Array.isArray(rows) || rows.length === 0) {
      console.log(`SKIP ${r.code} (${r.label}): R8/6 行が見つからない`);
      continue;
    }
    const formula = { type: "monthly_aggregate", numerator: r.num, denominator: 1000 };
    for (const row of rows) {
      const cur = row.formula ? `${row.formula.numerator}/${row.formula.denominator}` : "null";
      console.log(`${EXECUTE ? "UPDATE" : "[dry] UPDATE"} ${r.code} ${row.service_name.trim()} formula: ${cur} → ${r.num}/1000`);
      if (EXECUTE) {
        const res = await fetch(`${SB_URL}/rest/v1/kaigo_service_codes?id=eq.${row.id}`, {
          method: "PATCH", headers: H, body: JSON.stringify({ formula }),
        });
        if (!res.ok) throw new Error(`update failed ${r.code}: ${await res.text()}`);
      }
    }
  }
  console.log(EXECUTE ? "done." : "DRY RUN (実行するには --execute)");
};
main().catch((e) => { console.error(e); process.exit(1); });
