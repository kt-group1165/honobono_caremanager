/**
 * 予防給付の加算コード修正 (2026-09-05) の実データ確認 (READ ONLY)
 *
 * 事前投入 (このscriptは投入/撤去しない):
 *   clients: user_number=ZG930, care_level=要支援2
 *   kaigo_bath_visit_records: service_code=621111 ×2、
 *     1回目 addon_shokai=true・addon_ninchi=I・addon_chuusankan=true
 *     2回目 addon_ninchi=II
 *
 *   npx tsx scripts/bath-yobo-addon-fix-sample-verify.mts
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { aggregateBathVisitSeikyu } from "../src/lib/bath-seikyu/aggregate";

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let n = 0, ng = 0;
function eq(label: string, actual: unknown, expected: unknown) {
  n++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) ng++;
  console.log(`  ${ok ? "OK " : "NG "} ${label.padEnd(60)} ${ok ? "" : `実際=${JSON.stringify(actual)} 期待=${JSON.stringify(expected)}`}`);
}

const result = await aggregateBathVisitSeikyu(sb as never, { officeId: "ec87a203-53e2-40a5-b706-7fea402cde16", tenantId: "kt-group", year: 2026, month: 12 });
const row = result.rows.find((r) => r.user_name?.includes("サンプル930"));
if (!row) {
  console.log("⚠ サンプル930が見つからない。事前投入が要る(スクリプト冒頭のコメント参照)");
  process.exit(0);
}

console.log(`care_level: ${row.care_level}`);
console.log(`明細: ${row.details.map((d) => `${d.service_code}(${d.units})`).join(", ")}`);

const shokai = row.details.find((d) => d.service_code === "624001");
const ninchiI = row.details.find((d) => d.service_code === "626133");
const ninchiII = row.details.find((d) => d.service_code === "626134");
const chuusankan = row.details.find((d) => d.service_code === "628110");
const kaigoLeak = row.details.filter((d) => /^12[46]/.test(String(d.service_code ?? "")));

eq("★ 初回加算は624001(予防)が付く。124113(介護)ではない", !!shokai, true);
eq("★ 認知症専門ケアⅠは626133(予防)が付く", !!ninchiI, true);
eq("★ 認知症専門ケアⅡは626134(予防)が付く", !!ninchiII, true);
eq("★ 中山間は628110(予防)が付く", !!chuusankan, true);
eq("★ 介護給付系の加算コード(124/126系)は1つも混入していない (制度混在なし)", kaigoLeak.length, 0);
eq("初回加算の単位数=200 (624001)", shokai?.units, 200);
eq("認知症Ⅰの単位数=3 (626133, 1回)", ninchiI?.units, 3);
eq("認知症Ⅱの単位数=4 (626134, 1回)", ninchiII?.units, 4);
console.log(`     中山間: units=${chuusankan?.units} (所定単位×5%)`);

console.log(`\n══ 検査 ${n} 件 / NG ${ng} 件 ══`);
if (ng > 0) process.exitCode = 1;
