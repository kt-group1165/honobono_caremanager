// ============================================================================
// いすみの障害に **特別地域加算 (特地加算)** を設定する。
//
// ── 何が起きていたか ────────────────────────────────────────────────────
//   いすみの障害 J121 が 35 名中 2 名しか一致しなかった。
//   ほのぼのは全利用者に 116015 (居介特地加算) / 156015 (同援特地加算) を
//   算定しているのに、こちらの事業所設定に無く 1 件も出ていなかった。
//     1221801374: 基本 394 単位 → ほのぼの 特地 59 単位 (14.97%)
//     1223820067: 基本 15,246 → 2,287 (15.00%)
//   伝送 6 名で逆算していずれも **所定単位 × 15%** (告示どおり)。
//
//   ⚠ 特地加算は**中山間地域等に所在する事業所**に付く。いすみ市・大多喜町・
//     御宿町・勝浦市 が対象。他拠点 (千葉市内等) には付かないので
//     **いすみだけに入れる**。他拠点にも必要かは所在地で個別確認すること。
//
//   node migrations/add_shogai_tokuchi_addon_isumi.mjs            # DRY RUN
//   node migrations/add_shogai_tokuchi_addon_isumi.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const OFFICE_ID = "4015f747-4f75-4769-a1f2-dca3db6a24fc"; // リンクスヘルパーステーションいすみ
const TENANT = "kt-group";
// 居宅介護 / 重度訪問介護 / 同行援護 の特地加算
const CODES = [
  ["116015", "居介特地加算"],
  ["126015", "重訪特地加算"],
  ["156015", "同援特地加算"],
];

function loadEnv() {
  const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function main() {
  console.log(`=== いすみ 障害 特別地域加算 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const { data: exist, error } = await sb
    .from("kaigo_office_addon_periods")
    .select("formula_code")
    .eq("office_id", OFFICE_ID);
  if (error) throw new Error(error.message);
  const have = new Set(exist.map((r) => r.formula_code));

  const { data: sc, error: e2 } = await sb
    .from("kaigo_service_codes")
    .select("service_code, service_name, units, formula")
    .eq("system", "障害")
    .in("service_code", CODES.map(([c]) => c));
  if (e2) throw new Error(e2.message);

  const add = [];
  for (const [code, label] of CODES) {
    if (have.has(code)) { console.log(`  (既存) ${code} ${label}`); continue; }
    const master = sc.find((r) => r.service_code === code);
    if (!master) { console.log(`  ⚠ ${code} ${label}: サービスコードマスタに無い → スキップ`); continue; }
    if (!master.formula) {
      console.log(`  ⚠ ${code} ${label}: マスタに formula (計算式) が無い。単位数=${master.units}`);
      console.log(`     → 15% の計算式が必要。マスタ側の整備が要る (この script では入れない)`);
    }
    add.push({ tenant_id: TENANT, office_id: OFFICE_ID, formula_code: code, notes: `${label} (中山間地域等 15%)` });
  }

  console.log(`\n追加する行 ${add.length} 件:`);
  for (const a of add) console.log(`  ← ${a.formula_code} ${a.notes}`);
  if (!add.length) { console.log("  (なし)"); return; }
  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で INSERT します。"); return; }

  const { error: e3 } = await sb.from("kaigo_office_addon_periods").insert(add);
  if (e3) { console.error(`✗ INSERT 失敗: ${e3.message}`); process.exit(1); }
  console.log(`✓ 完了: ${add.length} 行 INSERT`);

  const { data: after } = await sb
    .from("kaigo_office_addon_periods").select("formula_code").eq("office_id", OFFICE_ID);
  console.log(`🔎 verify: いすみの適用加算 = ${after.map((r) => r.formula_code).join(", ")}`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
