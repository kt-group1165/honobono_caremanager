/**
 * 障害 — 同行援護のサービス種類コード 14→15 修正 (2026-09-05) の検証
 * (純関数の負のコントロール + 実データでのラベル確認。READ ONLY)
 *
 * 背景: src/lib/shogai-seikyu/service-type-code.ts に一本化する前は
 * aggregate.ts / _shogai-meisai.tsx が別々に同じ辞書を持ち、同行援護を旧コード"14"
 * にしていたため、処遇改善加算等の行の「サービス種類」表示が同行援護だけ空欄に
 * なっていた (単位数・金額の計算には影響しない、表示のみのバグ)。
 *
 *   npx tsx scripts/shogai-doukou-label-fix-verify.mts
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { SERVICE_TYPE_LABELS } from "../src/lib/shogai-seikyu/service-type-code";
import { aggregateMonthlyShogaiSeikyu, buildShogaiSeikyuCsv } from "../src/lib/shogai-seikyu/aggregate";

let n = 0, ng = 0;
function eq(label: string, actual: unknown, expected: unknown) {
  n++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) ng++;
  console.log(`  ${ok ? "OK " : "NG "} ${label.padEnd(65)} ${ok ? "" : `実際=${JSON.stringify(actual)} 期待=${JSON.stringify(expected)}`}`);
}

console.log("═══ 純関数: SERVICE_TYPE_LABELS ═══");
eq("15 → 同行援護 (正しいコード)", SERVICE_TYPE_LABELS["15"], "同行援護");
eq("14 → 同行援護 (旧コード系。過去データのデコード用に維持)", SERVICE_TYPE_LABELS["14"], "同行援護");
eq("11 → 居宅介護 (回帰なし)", SERVICE_TYPE_LABELS["11"], "居宅介護");
eq("12 → 重度訪問介護 (回帰なし)", SERVICE_TYPE_LABELS["12"], "重度訪問介護");
eq("13 → 行動援護 (回帰なし)", SERVICE_TYPE_LABELS["13"], "行動援護");

console.log("\n═══ 負のコントロール ═══");
{
  // 修正前の辞書(14のみ・15を持たない)を再現し、現行との差分でこのテストが
  // B-1w系と同型のバグを検出できることを確認する
  const OLD_LABELS: Record<string, string> = { "11": "居宅介護", "12": "重度訪問介護", "13": "行動援護", "14": "同行援護" };
  n++;
  const real = SERVICE_TYPE_LABELS["15"];
  const broken = OLD_LABELS["15"];
  if (real !== broken) {
    console.log(`  OK  負のコントロール — 現行(${real})と旧辞書(${broken ?? "undefined"})が別の値 (このテストが回帰を検出できる)`);
  } else {
    ng++;
    console.log("  NG  負のコントロール失敗 — 修正前後で結果が変わらない");
  }
}

console.log("\n═══ 実データ確認 (READ ONLY) ═══");
const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// 五井 (同行援護処遇改善加算 155175 が2026-06以降有効な8事業所の1つ)
const result = await aggregateMonthlyShogaiSeikyu(sb as never, { officeId: "3f18eced-5f51-49b8-bfc1-afcfaa919035", year: 2026, month: 6 });
const csv = buildShogaiSeikyuCsv(result.rows, 2026, 6);
const shoguuRows = csv.split("\n").filter((l) => l.includes(",155175,"));
console.log(`155175(同行援護処遇改善加算) の行数: ${shoguuRows.length}`);
if (shoguuRows.length === 0) {
  console.log("⚠ 対象月に155175の算定行が無い (事業所の加算設定・実績を確認)");
} else {
  const cols = shoguuRows[0].split(",");
  // header: 提供年月,市町村番号,受給者証番号,氏名,障害支援区分,サービス種類コード,サービス種類,サービスコード,...
  eq("★ 155175行のサービス種類コード列 = 15", cols[5], "15");
  eq("★ 155175行のサービス種類列 = 同行援護 (修正前は空欄)", cols[6], "同行援護");
}

console.log(`\n══ 検査 ${n} 件 / NG ${ng} 件 ══`);
if (ng > 0) process.exitCode = 1;
