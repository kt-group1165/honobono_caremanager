// ============================================================================
// 処遇改善加算の「期中切替」を全ヘルパーステーションへ投入 (kaigo_office_addon_periods)
// ============================================================================
// 2026-07-24。令和8年6月改定で 5月まで/6月から の区分が変わるため、事業所ごとに
// 期間付きで区分 (service_code) を設定する。実データ (ほのぼの明細/伝送) で確認した区分:
//   介護 訪問介護 : 〜2026-05 = 116274 (加算Ⅱ 22.4%) / 2026-06〜 = 116184 (Ⅱ² 26.6%)
//   障害 居宅介護 : 〜2026-05 = 115121 (加算Ⅱ 40.2%) / 2026-06〜 = 115175 (Ⅱロ 44.1%)
// 対象 = 全 訪問介護 事業所 (app_type='kaigo-app', service_type='訪問介護', is_active)。
// 障害の区分は障害実績のある事業所でのみ発火する (障害実績が無い事業所には無害)。
//
//   node migrations/set_shoguu_addon_periods.mjs            # DRY RUN
//   node migrations/set_shoguu_addon_periods.mjs --execute  # 本番 (要 migration 適用)
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const NOTE = "処遇改善 期中切替 (2026-07-24投入)";

// 各制度の期中切替 (formula_code, start_month, end_month) [両端含む, null=境界なし]
const PERIODS = [
  { code: "116274", start: null, end: "2026-05", label: "介護 訪問介護 加算Ⅱ" },
  { code: "116184", start: "2026-06", end: null, label: "介護 訪問介護 Ⅱ²" },
  { code: "115121", start: null, end: "2026-05", label: "障害 居宅介護 加算Ⅱ" },
  { code: "115175", start: "2026-06", end: null, label: "障害 居宅介護 Ⅱロ" },
];

function loadEnv() {
  const t = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const e = {};
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return e;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// 制度別に formula(率) を検証表示するためのヘルパ
async function rateOf(code, system, ym) {
  const [y, m] = ym.split("-").map(Number);
  const first = `${ym}-01`;
  const { data } = await sb
    .from("kaigo_service_codes")
    .select("service_name, formula, valid_from, valid_until")
    .eq("service_code", code)
    .eq("system", system)
    .lte("valid_from", first);
  const rows = (data ?? []).filter(
    (r) => !r.valid_until || r.valid_until >= first,
  );
  const r = rows.sort((a, b) => (a.valid_from < b.valid_from ? 1 : -1))[0];
  if (!r || !r.formula) return `${code}:率未設定`;
  const f = r.formula;
  return `${r.service_name} ${((f.numerator / f.denominator) * 100).toFixed(1)}%`;
}

async function main() {
  console.log(`=== 処遇改善 期中切替 投入 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  // 検証: 各コードの率が想定どおりか (5月/6月)
  console.log("[率の確認]");
  console.log("  介護 5月:", await rateOf("116274", "介護", "2026-05"));
  console.log("  介護 6月:", await rateOf("116184", "介護", "2026-06"));
  console.log("  障害 5月:", await rateOf("115121", "障害", "2026-05"));
  console.log("  障害 6月:", await rateOf("115175", "障害", "2026-06"));
  console.log("");

  // 対象事業所
  const { data: offs, error } = await sb
    .from("offices")
    .select("id, name")
    .eq("app_type", "kaigo-app")
    .eq("service_type", "訪問介護")
    .eq("is_active", true)
    .order("name");
  if (error) throw new Error("事業所取得失敗: " + error.message);
  const offices = offs ?? [];
  console.log(`対象 訪問介護 事業所: ${offices.length}\n`);

  const payloads = [];
  for (const o of offices) {
    for (const p of PERIODS) {
      payloads.push({
        office_id: o.id,
        formula_code: p.code,
        start_month: p.start,
        end_month: p.end,
        note: NOTE,
      });
    }
  }
  console.log(`投入行数: ${payloads.length} (= ${offices.length}事業所 × ${PERIODS.length}区分)`);
  console.log("投入内容 (全事業所共通):");
  for (const p of PERIODS)
    console.log(`  ${p.code}  ${p.start ?? "〜"}〜${p.end ?? "∞"}  (${p.label})`);
  console.log("");

  if (!EXECUTE) {
    console.log("※ DRY RUN。--execute で投入 (upsert)。先に migrations/kaigo_office_addon_periods.sql を適用してください。");
    console.log("  例(先頭3事業所):");
    for (const o of offices.slice(0, 3)) console.log(`   - ${o.name}`);
    return;
  }

  const { error: upErr } = await sb
    .from("kaigo_office_addon_periods")
    .upsert(payloads, { onConflict: "office_id,formula_code,start_month" });
  if (upErr) {
    if (upErr.code === "42P01" || upErr.code === "PGRST205") {
      console.error("✗ テーブル未作成。先に migrations/kaigo_office_addon_periods.sql を適用してください。");
      process.exit(1);
    }
    console.error("✗ 投入失敗:", upErr.message);
    process.exit(1);
  }
  console.log(`✓ 完了: ${payloads.length}行を投入`);
}
main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
