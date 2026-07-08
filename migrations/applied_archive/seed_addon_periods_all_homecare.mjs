// 全訪問介護事業所に処遇改善加算の期間設定を投入
//   〜2026-05 = 処遇改善加算Ⅱ (116274) / 2026-06〜 = 処遇改善加算Ⅱ2 (116184)
// 既に同 office+code の行がある事業所 (おゆみ野等) は skip (冪等)
// usage: node --env-file=.env.local migrations/seed_addon_periods_all_homecare.mjs           # DRY RUN
//        node --env-file=.env.local migrations/seed_addon_periods_all_homecare.mjs --execute
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json", Prefer: "return=representation" };
const EXECUTE = process.argv.includes("--execute");

const PERIODS = [
  { formula_code: "116274", start_month: null, end_month: "2026-05", notes: "処遇改善加算Ⅱ (R8/5まで)" },
  { formula_code: "116184", start_month: "2026-06", end_month: null, notes: "処遇改善加算Ⅱ2 (R8/6から)" },
];

const main = async () => {
  // 対象: kaigo-app の訪問介護事業所 (active)
  const offices = await fetch(
    `${SB_URL}/rest/v1/offices?select=id,name,tenant_id,service_type,is_active&app_type=eq.kaigo-app&service_type=eq.訪問介護&is_active=eq.true&order=name`,
    { headers: H },
  ).then((r) => r.json());
  if (!Array.isArray(offices)) throw new Error("offices 取得失敗: " + JSON.stringify(offices));
  console.log(`対象の訪問介護事業所: ${offices.length} 件`);

  // 既存の期間設定を一括取得
  const existing = await fetch(
    `${SB_URL}/rest/v1/kaigo_office_addon_periods?select=office_id,formula_code`,
    { headers: H },
  ).then((r) => r.json());
  const has = new Set((existing ?? []).map((e) => e.office_id + "|" + e.formula_code));

  let planned = 0, skipped = 0;
  const inserts = [];
  for (const o of offices) {
    for (const p of PERIODS) {
      if (has.has(o.id + "|" + p.formula_code)) {
        skipped++;
        continue;
      }
      inserts.push({ office_id: o.id, tenant_id: o.tenant_id ?? "kt-group", ...p });
      planned++;
      console.log(`${EXECUTE ? "INSERT" : "[dry] INSERT"} ${o.name}: ${p.formula_code} (${p.start_month ?? "最初から"}〜${p.end_month ?? "無期限"})`);
    }
  }
  console.log(`\n予定 ${planned} 件 / skip ${skipped} 件 (既存)`);

  if (EXECUTE && inserts.length > 0) {
    for (let i = 0; i < inserts.length; i += 100) {
      const res = await fetch(`${SB_URL}/rest/v1/kaigo_office_addon_periods`, {
        method: "POST", headers: H, body: JSON.stringify(inserts.slice(i, i + 100)),
      });
      if (!res.ok) throw new Error("insert failed: " + (await res.text()));
    }
    // 検証
    const after = await fetch(
      `${SB_URL}/rest/v1/kaigo_office_addon_periods?select=office_id`,
      { headers: H },
    ).then((r) => r.json());
    console.log(`✅ 完了。kaigo_office_addon_periods 現在 ${after.length} 行`);
  } else if (!EXECUTE) {
    console.log("DRY RUN (実行するには --execute)");
  }
};
main().catch((e) => { console.error(e); process.exit(1); });
