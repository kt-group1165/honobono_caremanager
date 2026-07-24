// ============================================================================
// 処遇改善加算 (令和8年6月新設 等) の formula(率) が null のマスタを埋める
// ============================================================================
// 2026-07-24。居宅介護支援・訪問看護 は従来 処遇改善 対象外だったが令和8年6月から
// 新設 (単一区分)。マスタに service_code は在るが formula(率) が null のため請求で
// 算定されない。確定した率のみここで設定する (未確定は TODO のまま入れない)。
//
//   node migrations/fix_shoguu_null_formula.mjs            # DRY RUN
//   node migrations/fix_shoguu_null_formula.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");

// 確定分のみ。{code, system, num, den, label}
const FIXES = [
  { code: "436191", system: "介護", num: 21, den: 1000, label: "居宅介護支援 処遇改善 2.1%" },
  // TODO(要告示確認): 訪問看護 136191 / 訪問入浴 Ⅱ² 126184・Ⅰ② 126183 は率未確定のため保留
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

async function main() {
  console.log(`=== 処遇改善 formula 設定 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);
  for (const f of FIXES) {
    // 対象世代 (formula が null の該当コード) を確認
    const { data, error } = await sb
      .from("kaigo_service_codes")
      .select("id, service_code, service_name, formula, valid_from, valid_until")
      .eq("service_code", f.code)
      .eq("system", f.system);
    if (error) throw new Error(`${f.code} 取得失敗: ${error.message}`);
    const targets = (data ?? []).filter((r) => r.formula == null);
    const formula = {
      type: "monthly_aggregate",
      label: `所定単位×${f.num}/${f.den}`,
      rounding: "round",
      numerator: f.num,
      denominator: f.den,
    };
    console.log(`${f.label}  (${f.code}) → ${((f.num / f.den) * 100).toFixed(1)}%`);
    for (const r of data ?? [])
      console.log(`   ${r.service_name} ${r.valid_from}〜${r.valid_until ?? "∞"}  現formula=${r.formula ? "設定済(スキップ)" : "null(対象)"}`);
    if (targets.length === 0) {
      console.log("   → 対象なし (既に設定済 or コード無し)\n");
      continue;
    }
    if (EXECUTE) {
      const { error: upErr } = await sb
        .from("kaigo_service_codes")
        .update({ formula })
        .in("id", targets.map((r) => r.id));
      if (upErr) {
        console.error(`   ✗ 更新失敗: ${upErr.message}`);
        process.exit(1);
      }
      console.log(`   ✓ ${targets.length}件に formula 設定\n`);
    } else {
      console.log(`   → --execute で ${targets.length}件に ${JSON.stringify(formula)} を設定\n`);
    }
  }
  if (!EXECUTE) console.log("※ DRY RUN。--execute で更新。");
}
main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
