/**
 * 訪問入浴 網羅率サンプル (seed_sample_bath_c.mjs ZC001-005 + seed_sample_bath_coverage_g.mjs
 * G1-6) の実データ検証 (READ ONLY・aggregateBathVisitSeikyu を直接呼ぶ)
 *
 *   node migrations/seed_sample_bath_c.mjs --execute
 *   node migrations/seed_sample_bath_coverage_g.mjs --execute
 *   npx tsx scripts/bath-coverage-sample-verify.mts
 *   node migrations/seed_sample_bath_coverage_g.mjs --delete --execute
 *   node migrations/seed_sample_bath_c.mjs --delete --execute
 *
 * B-1w (要支援に介護給付コード) / B-1y (処遇改善未設定→0円) が今も再現するかを
 * 実データで確認する。直さない。測って記録するだけ。
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { aggregateBathVisitSeikyu } from "../src/lib/bath-seikyu/aggregate";

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY が無い");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const OFFICE_ID = "ec87a203-53e2-40a5-b706-7fea402cde16"; // ムツミ訪問入浴
let n = 0, ng = 0;
function eq(label: string, actual: unknown, expected: unknown) {
  n++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) ng++;
  console.log(`  ${ok ? "OK " : "NG "} ${label.padEnd(60)} ${ok ? "" : `実際=${JSON.stringify(actual)} 期待=${JSON.stringify(expected)}`}`);
}

console.log("══ 訪問入浴 網羅率サンプル検証 (2026-12・READ ONLY) ══\n");

const result = await aggregateBathVisitSeikyu(sb as never, { officeId: OFFICE_ID, tenantId: "kt-group", year: 2026, month: 12 });
console.log(`【分母】集計対象クライアント: ${result.rows.length} 名 / 訪問記録: ${result.recordCount} 件\n`);

if (result.rows.length !== 11) {
  console.log(`  ⚠ 期待は11名(ZC×5+G×6)。両方のseed scriptを --execute 済みか確認してください`);
  process.exit(result.rows.length === 0 ? 0 : 1);
}

const byName = (label: string) => result.rows.find((r) => r.user_name?.includes(label));
const zc005 = byName("四郎"); // 要支援2
const g1 = byName("サンプル1"), g2 = byName("サンプル2"), g3 = byName("サンプル3"),
  g4 = byName("サンプル4"), g5 = byName("サンプル5"), g6 = byName("サンプル6");

console.log("═══ B-1w: 要支援なのに介護給付コードで算定していないか (ZC005) ═══");
{
  eq("care_level = 要支援2", zc005?.care_level, "要支援2");
  const kaigoKyufuDetail = zc005?.details.find((d) => /^12/.test(String(d.service_code ?? "")));
  eq("★ B-1w再現: 要支援なのに種類12のコード(121xxx)で算定されている", !!kaigoKyufuDetail, true);
  // ⚠ 2026-09-05実測: warningsByClient は常に{}(未実装・使われていない)。flatなwarningsを見る
  const hasWarning = result.warnings.some((w) => w.includes(zc005!.user_name) && w.includes("予防給付"));
  eq("★ 警告が出る(直さないが検出はできる)", hasWarning, true);
  console.log(`     ${kaigoKyufuDetail?.service_code} (${kaigoKyufuDetail?.units}単位) が要支援2に付いている。正しくは621111系(856単位)`);
}

console.log("\n═══ G1: 中山間地域等提供加算 ═══");
{
  const chuusankan = g1?.details.find((d) => d.service_code === "128110");
  eq("中山間加算の明細行がある", !!chuusankan, true);
  console.log(`     units=${chuusankan?.units} (所定単位×5%)`);
}

console.log("\n═══ G2: 部分公費 (法別21・生保以外) ═══");
{
  eq("kohiHobetsu = 21", g2?.kohiHobetsu, "21");
  eq("★ 部分公費は振替されない (publicExpense=null)", g2?.publicExpense, null);
  eq("userAmount > 0 (振替されないので通常の自己負担が残る)", (g2?.userAmount ?? 0) > 0, true);
}

console.log("\n═══ G3: 認知症専門ケアⅠ (既存サンプルはⅡのみだった) ═══");
{
  const ninchiI = g3?.details.find((d) => d.service_code === "126133");
  eq("認知症専門ケアⅠ(126133)の明細行がある", !!ninchiI, true);
  eq("2回分 (2訪問×3単位=6)", ninchiI?.units, 6);
}

console.log("\n═══ G4: 月内の要介護度変更 (要介護1→要介護3) ═══");
{
  const warns = result.warnings.filter((w) => w.includes(g4!.user_name));
  const hasChangeWarning = warns.some((w) => w.includes("区分変更") || w.includes("変更"));
  eq("★ 月内区分変更の警告が出る", hasChangeWarning, true);
  eq("限度額は重い方(要介護3=27,048)を適用", g4?.limitUnits, 27048);
  console.log(`     警告: ${warns.join(" / ")}`);
}

console.log("\n═══ G5: 限度額ちょうど (bath_monthly_plan_units=5,064で計画単位数を明示) ═══");
{
  eq("planUnits = 5,064 (計画単位数が反映される)", g5?.planUnits, 5064);
  eq("limitUnits = 5,064 (計画単位数が限度額として優先される)", g5?.limitUnits, 5064);
  eq("grossBaseUnits = 5,064 (4回×1,266)", g5?.grossBaseUnits, 5064);
  eq("★ ちょうど → overUnits = 0", g5?.overUnits, 0);
}

console.log("\n═══ G6: 虐防(高齢者虐待防止措置未実施)減算 ═══");
{
  const has121 = g6?.details.some((d) => /^121/.test(String(d.service_code ?? "")));
  console.log(`     G6の明細: ${g6?.details.map((d) => `${d.service_code}(${d.units})`).join(", ")}`);
  const gensanWarn = result.warnings.find((w) => w.includes(g6!.user_name) && (w.includes("減算") || w.includes("虐待") || w.includes("マスタ")));
  if (gensanWarn) {
    console.log(`     ⚠ 減算バリエーション未解決の警告: ${gensanWarn}`);
    console.log(`     → マスタに合成コードが無いため、元コードのまま(減算なし)で集計されている`);
  } else {
    console.log(`     → 減算が適用された(合成コードに差し替わった)か、適用対象外だった`);
  }
  eq("G6にも通常の明細行がある(集計自体は継続する)", has121 || (g6?.details.length ?? 0) > 0, true);
}

console.log("\n═══ B-1y: 処遇改善が未設定(空)だと0円になるか ═══");
{
  const zeroAddon = result.rows.every((r) => r.addonUnits === 0);
  eq("★ B-1y再現: appliedFormulaCodes未指定 → 全員addonUnits=0", zeroAddon, true);
}
{
  // 対照: 処遇改善コードを渡すと実際に加算されることを確認 (経路自体は生きている)
  const withFormula = await aggregateBathVisitSeikyu(sb as never, {
    officeId: OFFICE_ID, tenantId: "kt-group", year: 2026, month: 12,
    appliedFormulaCodes: ["訪問介護support"], // ダミー。実在しないコードでも「未解決」経路が動くかを見る
  });
  const g1WithFormula = withFormula.rows.find((r) => r.user_name?.includes("サンプル1"));
  console.log(`     ダミーの処遇改善コードを渡した場合のaddonUnits=${g1WithFormula?.addonUnits ?? "取得不可"} (実在しないコードなので0のままが正しい可能性が高い。経路確認のみ)`);
}

console.log(`\n══ 検査 ${n} 件 / NG ${ng} 件 ══`);
if (ng > 0) process.exitCode = 1;
console.log("\n次: node migrations/seed_sample_bath_coverage_g.mjs --delete --execute");
console.log("    node migrations/seed_sample_bath_c.mjs --delete --execute");
