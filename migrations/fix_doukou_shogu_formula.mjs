// 同行援護の処遇改善加算 (155174/155175) に formula を補完する。
//
// 背景 (2026-08-03):
//   五井の伝送に 155175「同援処遇改善加算Ⅱロ」が 6 名分あるのに新システムが出せなかった。
//   原因はロジックではなく**マスタの formula が null** だったこと。
//   同系列の 居宅介護 115175 / 重訪 125175 には formula が入っている:
//     115175 居介処遇改善加算Ⅱロ  所定単位×441/1000
//     125175 重訪処遇改善加算Ⅱロ  所定単位×367/1000
//     155175 同援処遇改善加算Ⅱロ  → null  ★ここ
//     155174 同援処遇改善加算Ⅰロ  → null
//
//   ほのぼの伝送の実データで率を検算 (所定単位に対する加算単位):
//     1221902230  2355 / 5340  = 441.0‰
//     1221903287  3007 / 6819  = 441.0‰
//     1221905829   880 / 1996  = 440.9‰
//     1221935503  1628 / 3692  = 441.0‰
//     1221940941  1278 / 2899  = 440.8‰
//     1221945148  2662 / 6036  = 441.0‰
//   → **441/1000**。居宅介護Ⅱロと同率で、丸めは round (端数は四捨五入)。
//
//   Ⅰロ (155174) は Ⅰイ(155120)=417‰ より上位。居宅介護の対応関係
//   (115120 Ⅰイ / 115174 Ⅰロ) から率を引く。実データが無いので**Ⅱロのみ**を既定で入れ、
//   Ⅰロは --with-i-ro 指定時のみ (未検証のため既定では触らない)。
//
//   node migrations/fix_doukou_shogu_formula.mjs [--execute] [--with-i-ro]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const WITH_I_RO = process.argv.includes("--with-i-ro");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
function loadEnv() {
  const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8");
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

// 補完対象。numerator は「対応する居宅介護コードの率」を根拠にする
const TARGETS = [
  { code: "155175", name: "同援処遇改善加算Ⅱロ", num: 441, ref: "115175 居介処遇改善加算Ⅱロ + 伝送実データ6名で検算" },
];
if (WITH_I_RO) {
  TARGETS.push({ code: "155174", name: "同援処遇改善加算Ⅰロ", num: null, ref: "115174 から引く (実データ無し)" });
}

async function main() {
  console.log(`=== 同行援護 処遇改善加算の formula 補完 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  // 根拠となる居宅介護側の率を確認
  const { data: refs, error: e0 } = await sb
    .from("kaigo_service_codes")
    .select("service_code, service_name, formula, valid_from")
    .eq("system", "障害")
    .in("service_code", ["115174", "115175", "125175"])
    .not("formula", "is", null);
  if (e0) { console.error("参照コードの取得に失敗:", e0.message); process.exit(1); }
  const refRate = new Map();
  for (const r of refs ?? []) {
    if (!refRate.has(r.service_code)) refRate.set(r.service_code, r.formula?.numerator ?? null);
  }
  console.log("参照 (居宅介護・重訪の同系列):");
  for (const [c, n] of refRate) console.log(`  ${c} → ${n}/1000`);
  console.log("");

  const plan = [];
  for (const t of TARGETS) {
    const num = t.num ?? refRate.get(t.code.replace(/^155/, "115")) ?? null;
    if (num == null) {
      console.error(`✗ ${t.code} の率が決められません (参照コードにも formula なし) → 中止`);
      process.exit(1);
    }
    const { data: rows, error } = await sb
      .from("kaigo_service_codes")
      .select("id, service_code, service_name, formula, valid_from, valid_until")
      .eq("system", "障害")
      .eq("service_code", t.code);
    if (error) { console.error(`${t.code} の取得に失敗:`, error.message); process.exit(1); }
    if (!rows?.length) { console.error(`✗ ${t.code} がマスタにありません → 中止`); process.exit(1); }
    for (const r of rows) {
      if (r.formula) {
        console.log(`  ${t.code} (${r.valid_from}) は既に formula あり → スキップ`);
        continue;
      }
      plan.push({ id: r.id, code: t.code, name: r.service_name, from: r.valid_from, num, ref: t.ref });
    }
  }

  if (plan.length === 0) { console.log("更新対象なし。"); return; }
  console.log(`更新対象 ${plan.length} 行:`);
  for (const p of plan) {
    console.log(`  ${p.code} ${p.name} (${p.from}) → 所定単位×${p.num}/1000  [根拠: ${p.ref}]`);
  }
  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で UPDATE します。"); return; }

  let n = 0;
  for (const p of plan) {
    const formula = {
      type: "monthly_aggregate",
      label: `所定単位×${p.num}/1000`,
      rounding: "round",
      numerator: p.num,
      denominator: 1000,
      service_category: "15",
    };
    const { error } = await sb.from("kaigo_service_codes").update({ formula }).eq("id", p.id);
    if (error) { console.error(`UPDATE 失敗 (${p.code}):`, error.message); process.exit(1); }
    n++;
  }
  console.log(`\n✓ 完了: ${n} 行を更新`);
  console.log("  → 事業所の加算区分 (kaigo_office_addon_periods) に 155175 を登録すると算定されます。");
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
