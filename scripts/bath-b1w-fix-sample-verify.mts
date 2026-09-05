/**
 * B-1w 修正 (要支援→種類62) の実データ確認 (READ ONLY・aggregateBathVisitSeikyu を直接呼ぶ)
 *
 * 事前に1回だけ以下を投入しておくこと (このscriptはREAD ONLY・投入/撤去はしない):
 *   clients: user_number=ZG910, name末尾[sample-g], care_level=要支援2
 *   client_insurance_records: 同上, service_limit_amount=10531
 *   client_office_assignments: office_id=ムツミ訪問入浴
 *   kaigo_bath_visit_records: service_code="621111" (修正後resolveBathCodeが返す値)
 *
 *   npx tsx scripts/bath-b1w-fix-sample-verify.mts
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { aggregateBathVisitSeikyu } from "../src/lib/bath-seikyu/aggregate";
import { resolveBathCode } from "../src/lib/bath-seikyu/resolve-code";

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
const row = result.rows.find((r) => r.user_name?.includes("サンプル910"));
if (!row) {
  console.log("⚠ サンプル910が見つからない。事前投入が要る(スクリプト冒頭のコメント参照)");
  process.exit(0);
}

console.log(`care_level: ${row.care_level}`);
console.log(`service_code: ${row.details.map((d) => d.service_code).join(",")}`);
console.log(`totalUnits: ${row.totalUnits} / insuranceAmount: ${row.insuranceAmount}円`);

eq("修正後のresolveBathCodeは要支援2に621111を返す (このデータもそれで作った)", resolveBathCode("全身浴", false, "要支援2"), "621111");
eq("★ 修正後: 621111が使われ 856単位になっている (修正前は121111=1,266単位だった)", row.totalUnits, 856);
console.log(`\n★ 差分: 1,266単位(修正前・誤り) → 856単位(修正後・正しい) = 1回あたり410単位・${Math.round(410 * 10.7)}円相当の過大請求を防止`);

console.log(`\n══ 検査 ${n} 件 / NG ${ng} 件 ══`);
if (ng > 0) process.exitCode = 1;
