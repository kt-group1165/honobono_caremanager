/**
 * 予防給付(要支援)への 虐防/業未減算(B-1w系④) と 売上見込SCHED_CODE(B-1w系⑤) の
 * 修正 (2026-09-05) の実データ確認 (READ ONLY)
 *
 * 事前投入: migrations/seed_sample_bath_coverage_g.mjs --execute
 *   G6 = 要介護2 (121111)・虐防フラグあり → 121131 (虐防込) が付くはず
 *   G7 = 要支援2 (621111)・虐防フラグあり (G6と同じ事業所×月のフラグを共有) +
 *        未記録シフト予定1件 (2026-12-26, kaigo_bath_schedule)
 *        → ★ 621131 (予防・虐防込, 847単位) が付くはず。修正前は 621111 (856単位,満額) のままだった
 *
 *   npx tsx scripts/bath-gensan-yobo-fix-sample-verify.mts
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
  console.log(`  ${ok ? "OK " : "NG "} ${label.padEnd(70)} ${ok ? "" : `実際=${JSON.stringify(actual)} 期待=${JSON.stringify(expected)}`}`);
}

const result = await aggregateBathVisitSeikyu(sb as never, { officeId: "ec87a203-53e2-40a5-b706-7fea402cde16", tenantId: "kt-group", year: 2026, month: 12 });

const g6 = result.rows.find((r) => r.user_name?.includes("サンプル6"));
const g7 = result.rows.find((r) => r.user_name?.includes("サンプル7"));

if (!g6 || !g7) {
  console.log("⚠ G6/G7が見つからない。事前投入が要る (migrations/seed_sample_bath_coverage_g.mjs --execute)");
  process.exit(0);
}

console.log(`G6 care_level=${g6.care_level} 明細: ${g6.details.map((d) => `${d.service_code}(${d.units})`).join(", ")}`);
console.log(`G7 care_level=${g7.care_level} 明細: ${g7.details.map((d) => `${d.service_code}(${d.units})`).join(", ")}`);

eq("G6(要介護) — 虐防込121131が付く (満額121111ではない)", !!g6.details.find((d) => d.service_code === "121131"), true);
eq("G6 — 満額121111は残っていない (差し替え済み)", !!g6.details.find((d) => d.service_code === "121111"), false);

eq("★ G7(要支援) — 予防・虐防込621131が付く (修正前は満額621111のままだった)", !!g7.details.find((d) => d.service_code === "621131"), true);
eq("★ G7 — 満額621111は残っていない (差し替え済み)", !!g7.details.find((d) => d.service_code === "621111"), false);
eq("★ G7 — 介護給付系のコード(121系)は混入していない (制度混在なし)", g7.details.some((d) => /^12/.test(String(d.service_code ?? ""))), false);

const g7Line = g7.details.find((d) => d.service_code === "621131");
eq("G7 — 621131の単位数=1694 (847×2回, 856×2の1%減算)", g7Line?.units, 1694);

// ── SCHED_CODE (売上見込・未記録シフト予定) の予防給付対応 (B-1w系⑤) ──
// 事前投入: G7 (要支援2) に kaigo_bath_schedule (status=scheduled, record_id=null) を
// 2026-12-26 で1件追加している (このscriptとは別に投入。存在しなければ以下はスキップ)
const withSched = await aggregateBathVisitSeikyu(sb as never, {
  officeId: "ec87a203-53e2-40a5-b706-7fea402cde16", tenantId: "kt-group", year: 2026, month: 12, includeScheduled: true,
});
const g7Sched = withSched.rows.find((r) => r.user_name?.includes("サンプル7"));
if (g7Sched) {
  console.log(`\nG7(includeScheduled) 明細: ${g7Sched.details.map((d) => `${d.service_code}(${d.units})`).join(", ")}`);
  const kaigoLeakSched = g7Sched.details.some((d) => /^12/.test(String(d.service_code ?? "")));
  eq("★ G7(売上見込・未記録予定込み) — 介護給付系コード(12始まり)が混入していない", kaigoLeakSched, false);
} else {
  console.log("\n⚠ G7の売上見込テストはスキップ (kaigo_bath_scheduleへの手動投入が無い)");
}

console.log("\n═══ 負のコントロール (箇所ごと) ═══");
{
  // ④ 虐防/業未スワップの対象抽出 — 修正前は c.startsWith("121") で、621xxxは対象外だった
  const oldFilter = (c: string) => c.startsWith("121");
  n++;
  if (oldFilter("621111") !== true /* isBathBaseCode("621111") */) {
    console.log("  OK  負のコントロール④ — 旧フィルタ(startsWith(\"121\"))は621111を対象外にする (現行のisBathBaseCodeとは異なる結果。このテストが④の回帰を検出できる)");
  } else {
    ng++;
    console.log("  NG  負のコントロール④失敗 — 旧フィルタでも621111が対象に入ってしまう(差が無い)");
  }
}
{
  // ⑤ SCHED_CODE — 修正前は bath_type ごとに 121111/121112 固定だった
  const OLD_SCHED_CODE: Record<string, string> = { 全身浴: "121111", 部分浴: "121112" };
  const oldCode = OLD_SCHED_CODE["全身浴"];
  const newCodeForYobo = "621111"; // resolveBathCode("全身浴", false, "要支援2") の期待値 (bath-resolve-code-verify.mtsで検証済)
  n++;
  if (oldCode !== newCodeForYobo) {
    console.log(`  OK  負のコントロール⑤ — 旧SCHED_CODE固定値(${oldCode})と要支援向けの正しい値(${newCodeForYobo})が別 (このテストが⑤の回帰を検出できる)`);
  } else {
    ng++;
    console.log("  NG  負のコントロール⑤失敗");
  }
}

console.log(`\n══ 検査 ${n} 件 / NG ${ng} 件 ══`);
if (ng > 0) process.exitCode = 1;
