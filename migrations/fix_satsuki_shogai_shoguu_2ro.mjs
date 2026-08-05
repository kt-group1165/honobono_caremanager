// ============================================================================
// さつきが丘の障害 処遇改善加算を Ⅱイ → Ⅱロ に戻す。
//
// ── 経緯 ──────────────────────────────────────────────────────────────
//   6 月伝送の突合で「さつきが丘だけ ほのぼのが Ⅱイ で請求していた」ことに気づき、
//   ほのぼのに合わせて 115121 (居介Ⅱイ) / 125121 (重訪Ⅱイ) に変更していた。
//   その後 user が届出を確認 → **正しくは Ⅱロ**、ほのぼの側の設定漏れと判明。
//   よって新システムを正 (Ⅱロ) に戻し、伝送突合は**意図的に不一致**とする。
//   (船橋の処遇改善 未算定と同じ扱い)
//
//   → ほのぼのが 6 月に取りこぼした差額は過誤申立の業務判断へ。
//
//   node migrations/fix_satsuki_shogai_shoguu_2ro.mjs            # DRY RUN
//   node migrations/fix_satsuki_shogai_shoguu_2ro.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const OFFICE_ID = "be3218e6-9b47-4093-ab7e-46f388242fcc"; // Ｈａｎａヘルパーステーションさつきが丘
// Ⅱイ → Ⅱロ
const REMAP = { "115121": "115175", "125121": "125175" };

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
  console.log(`=== さつきが丘 障害 処遇改善 Ⅱイ→Ⅱロ ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const { data, error } = await sb
    .from("kaigo_office_addon_periods")
    .select("id, formula_code, start_month, end_month, notes")
    .eq("office_id", OFFICE_ID)
    .in("formula_code", Object.keys(REMAP));
  if (error) throw new Error(error.message);

  if (!data.length) {
    console.log("対象なし (既に Ⅱロ か、設定そのものが無い)。");
    return;
  }

  const codes = [...new Set([...Object.keys(REMAP), ...Object.values(REMAP)])];
  const { data: sc, error: e2 } = await sb
    .from("kaigo_service_codes")
    .select("service_code, service_name")
    .eq("system", "障害")
    .in("service_code", codes);
  if (e2) throw new Error(e2.message);
  const nameOf = (c) => sc.find((x) => x.service_code === c)?.service_name ?? "?";

  for (const r of data) {
    const to = REMAP[r.formula_code];
    console.log(
      `  ${r.formula_code} ${nameOf(r.formula_code)}  →  ${to} ${nameOf(to)}` +
        `  (${r.start_month ?? "開始なし"}〜${r.end_month ?? "終了なし"})`,
    );
  }
  console.log(`\n更新対象: ${data.length} 行`);
  if (!EXECUTE) {
    console.log("※ DRY RUN。--execute で更新します。");
    return;
  }

  for (const r of data) {
    const to = REMAP[r.formula_code];
    const { error: uErr } = await sb
      .from("kaigo_office_addon_periods")
      .update({
        formula_code: to,
        notes: `${nameOf(to)} (届出どおり Ⅱロ に是正 2026-08-05。ほのぼのは Ⅱイ で請求していた設定漏れ)`,
      })
      .eq("id", r.id);
    if (uErr) {
      console.error(`✗ ${r.formula_code}: ${uErr.message}`);
      process.exit(1);
    }
  }
  console.log(`✓ 完了: ${data.length} 行を Ⅱロ に更新`);

  // verify
  const { data: after, error: e3 } = await sb
    .from("kaigo_office_addon_periods")
    .select("formula_code")
    .eq("office_id", OFFICE_ID);
  if (e3) throw new Error(e3.message);
  const left = after.filter((r) => REMAP[r.formula_code]);
  console.log(`🔎 verify: さつきが丘に残る Ⅱイ 設定 = ${left.length} 件`);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
