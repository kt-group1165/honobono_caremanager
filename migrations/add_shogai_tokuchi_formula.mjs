// ============================================================================
// 障害の**特別地域加算 (特地加算)** に計算式 (formula) を入れる。
//
// ── なぜ要るか ────────────────────────────────────────────────────────
//   116015 (居介特地) 等は マスタで **単位数 0 かつ formula 無し**なので、
//   事業所に適用加算として設定しても 1 件も算定されない。
//   いすみは中山間地域等でほのぼのが全利用者に算定しているため、
//   J121 が 35 名中 2 名しか一致しなかった。
//
//   率は伝送 (KJ260802) から実証:
//     1221801374 基本   394 → 特地   59 (14.97%)
//     1223800812 基本 2,760 → 特地  414 (15.00%)
//     1223820042 基本 6,868 → 特地 1,030 (15.00%)
//     1223820067 基本15,246 → 特地 2,287 (15.00%)
//   → **所定単位 × 15/100** (告示どおり)。端数は round (処遇改善と同じ)。
//
// ── 対象 ──────────────────────────────────────────────────────────────
//   訪問系 4 種のみ: 116015 居介 / 126015 重訪 / 136015 行援 / 156015 同援。
//   ⚠ 356015 (自立生活援助 230単位) / 476015 (就労定着 240単位) は
//     **定額**で既に単位数が入っているので触らない。
//   ⚠ 施設・相談系 (416015/426015/526015/536015/546015/556015) は
//     事業範囲外なので触らない。
//
//   node migrations/add_shogai_tokuchi_formula.mjs            # DRY RUN
//   node migrations/add_shogai_tokuchi_formula.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
// サービス種類コード (先頭2桁) → formula の service_category
const TARGET = {
  "116015": "11", // 居宅介護
  "126015": "12", // 重度訪問介護
  "136015": "13", // 行動援護
  "156015": "15", // 同行援護
};

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
  console.log(`=== 障害 特別地域加算 の計算式を投入 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const { data, error } = await sb
    .from("kaigo_service_codes")
    .select("id, service_code, service_name, units, formula, valid_from, valid_until")
    .eq("system", "障害")
    .in("service_code", Object.keys(TARGET))
    .order("service_code");
  if (error) throw new Error(error.message);

  const plan = [];
  for (const r of data) {
    if (r.formula) { console.log(`  (既存 formula) ${r.service_code} ${r.service_name} ${r.valid_from}`); continue; }
    if (r.units) { console.log(`  ⚠ ${r.service_code} ${r.service_name}: 単位数 ${r.units} が入っている → 触らない`); continue; }
    plan.push({
      id: r.id,
      code: r.service_code,
      name: r.service_name,
      from: r.valid_from,
      formula: {
        type: "monthly_aggregate",
        label: "所定単位×15/100",
        rounding: "round",
        numerator: 15,
        denominator: 100,
        service_category: TARGET[r.service_code],
      },
    });
  }

  console.log(`\n更新対象 ${plan.length} 行:`);
  for (const p of plan) {
    console.log(`  ${p.code} ${(p.name + "            ").slice(0, 12)} ${p.from}〜  ← ${p.formula.label} (種類${p.formula.service_category})`);
  }
  if (!plan.length) { console.log("  (なし)"); return; }
  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で UPDATE します。"); return; }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const bak = fileURLToPath(new URL(`./_backup_tokuchi_formula_${stamp}.json`, import.meta.url));
  writeFileSync(bak, JSON.stringify(data, null, 1), "utf8");
  console.log(`\nバックアップ: ${bak.split(/[\\/]/).pop()}`);

  let ok = 0;
  for (const p of plan) {
    const { error: uErr } = await sb
      .from("kaigo_service_codes")
      .update({ formula: p.formula })
      .eq("id", p.id);
    if (uErr) { console.error(`✗ ${p.code}: ${uErr.message}`); process.exit(1); }
    ok++;
  }
  console.log(`✓ 完了: ${ok} 行に formula を設定`);

  const { data: after } = await sb
    .from("kaigo_service_codes")
    .select("service_code, valid_from, formula")
    .eq("system", "障害")
    .in("service_code", Object.keys(TARGET));
  console.log(`🔎 verify: formula 有 = ${after.filter((r) => r.formula).length}/${after.length} 行`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
