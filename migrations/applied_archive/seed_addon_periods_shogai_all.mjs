// 全訪問介護事業所に「障害福祉」処遇改善加算の期間設定を投入
//   居宅介護:     〜2026-05 = 処遇改善Ⅱ (115121) / 2026-06〜 = 処遇改善Ⅱロ (115175)
//   重度訪問介護: 〜2026-05 = 処遇改善Ⅱ (125121) / 2026-06〜 = 処遇改善Ⅱロ (125175)
// (ほのぼのMORE 実画面確認: 全訪問介護事業所とも 6月からⅡ・ロ、5月までは旧Ⅱ)
// 既に同 office+code の行がある事業所は skip (冪等)。介護分 (116274/116184) には触らない
// usage: node --env-file=.env.local migrations/seed_addon_periods_shogai_all.mjs           # DRY RUN
//        node --env-file=.env.local migrations/seed_addon_periods_shogai_all.mjs --execute
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です (--env-file=.env.local を確認)");
  process.exit(1);
}
const H = { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json", Prefer: "return=representation" };
const EXECUTE = process.argv.includes("--execute");

const PERIODS = [
  { formula_code: "115121", start_month: null, end_month: "2026-05", notes: "障害 処遇改善Ⅱ (R8/5まで)" },
  { formula_code: "115175", start_month: "2026-06", end_month: null, notes: "障害 処遇改善Ⅱロ (R8/6から)" },
  { formula_code: "125121", start_month: null, end_month: "2026-05", notes: "重訪 処遇改善Ⅱ (R8/5まで)" },
  { formula_code: "125175", start_month: "2026-06", end_month: null, notes: "重訪 処遇改善Ⅱロ (R8/6から)" },
];

const main = async () => {
  // sanity check: 4 コードが 障害 マスタに formula 付きで存在するか
  const codes = PERIODS.map((p) => p.formula_code);
  const master = await fetch(
    `${SB_URL}/rest/v1/kaigo_service_codes?select=service_code,service_name,system,formula&system=eq.障害&service_code=in.(${codes.join(",")})`,
    { headers: H },
  ).then((r) => r.json());
  if (!Array.isArray(master)) throw new Error("kaigo_service_codes 取得失敗: " + JSON.stringify(master));
  for (const c of codes) {
    const hit = master.filter((m) => m.service_code === c);
    if (hit.length === 0) throw new Error(`マスタに障害コード ${c} が存在しません`);
    if (!hit.some((m) => m.formula)) throw new Error(`障害コード ${c} に formula が未設定です`);
    console.log(`master OK: ${c} = ${hit[0].service_name}`);
  }

  // 対象: kaigo-app の訪問介護事業所 (active)
  const offices = await fetch(
    `${SB_URL}/rest/v1/offices?select=id,name,tenant_id,service_type,is_active&app_type=eq.kaigo-app&service_type=eq.訪問介護&is_active=eq.true&order=name`,
    { headers: H },
  ).then((r) => r.json());
  if (!Array.isArray(offices)) throw new Error("offices 取得失敗: " + JSON.stringify(offices));
  console.log(`\n対象の訪問介護事業所: ${offices.length} 件`);

  // 既存の期間設定を一括取得 (office+code で冪等 skip)
  const existing = await fetch(
    `${SB_URL}/rest/v1/kaigo_office_addon_periods?select=office_id,formula_code`,
    { headers: H },
  ).then((r) => r.json());
  if (!Array.isArray(existing)) throw new Error("kaigo_office_addon_periods 取得失敗: " + JSON.stringify(existing));
  const has = new Set(existing.map((e) => e.office_id + "|" + e.formula_code));

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
      console.log(`${EXECUTE ? "INSERT" : "[dry] INSERT"} ${o.name}: ${p.formula_code} (${p.start_month ?? "最初から"}〜${p.end_month ?? "無期限"}) ${p.notes}`);
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
    // 検証: 障害4コードの行数を確認
    const after = await fetch(
      `${SB_URL}/rest/v1/kaigo_office_addon_periods?select=office_id,formula_code&formula_code=in.(${codes.join(",")})`,
      { headers: H },
    ).then((r) => r.json());
    console.log(`✅ 完了。障害コード (${codes.join("/")}) の期間設定 現在 ${after.length} 行 (期待: ${offices.length * 4})`);
  } else if (!EXECUTE) {
    console.log("DRY RUN (実行するには --execute)");
  }
};
main().catch((e) => { console.error(e); process.exit(1); });
