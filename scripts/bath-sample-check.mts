/**
 * 訪問入浴 サンプルの検証 — 段1 (算定・単位数) と 段2 (伝送様式) の両方
 *
 *   npx tsx scripts/bath-sample-check.mts
 *
 * ⚠ 期待値は **手計算で独立に導出**したもの。集計結果をコピーして期待値にしない
 *   (VERIFICATION_RULES 3-2: 現状維持を成功指標にしない)。
 *
 * 対象は seed_sample_bath_c.mjs が入れた 2026-12 のサンプルのみ (マーカー ZC*)。
 * サンプルが未投入なら **分母 0 と明記してスキップ** (0 件を合格と言わない)。
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { aggregateBathVisitSeikyu } from "@/lib/bath-seikyu/aggregate";

const env: Record<string, string> = {};
for (const l of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const OFFICE_ID = "ec87a203-53e2-40a5-b706-7fea402cde16"; // ムツミ訪問入浴
const UNIT_PRICE = 10.7;
const Y = 2026, M = 12;

/**
 * ── 手計算した期待値 ──────────────────────────────────────────────────
 * 単位: 121111 全身浴 1266 / 121112 部分浴 1139 / 121121 職員のみ 1203 /
 *       121122 職員のみ部分浴 1083 / 124113 初回 200(月1) / 126134 認知症Ⅱ 4(回)
 * 金額: 費用額 = floor(総単位 × 単価)
 *       保険  = floor(費用額 × (10−負担割合)/10)   ← 端数は利用者負担側
 */
const EXPECT: Record<string, {
  name: string; level: string; copay: number; limit: number;
  gross: number; over: number; base: number;
}> = {
  ZC001: { name: "見本 太郎", level: "要介護3", copay: 1, limit: 27048,
    gross: 1266 * 4 + 200, over: 0, base: 1266 * 4 + 200 },                  // 5,264
  ZC002: { name: "見本 花子", level: "要介護1", copay: 2, limit: 16765,
    gross: 1266 + 1139 + 1203 + 1083, over: 0, base: 4691 },                 // 4,691
  ZC003: { name: "見本 次郎", level: "要介護1", copay: 3, limit: 16765,
    gross: 1266 * 14, over: 1266 * 14 - 16765, base: 16765 },                // 17,724 / 超過 959
  ZC004: { name: "見本 三郎", level: "要介護5", copay: 1, limit: 36217,
    gross: 1266 * 3 + 4 * 3, over: 0, base: 3810 },                          // 3,810
  ZC005: { name: "見本 四郎", level: "要支援2", copay: 1, limit: 10531,
    gross: 1266, over: 0, base: 1266 },                                      // 1,266
};

let ng = 0, checked = 0;
const eq = (label: string, a: unknown, b: unknown) => {
  checked++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) ng++;
  console.log(`    ${ok ? "OK " : "NG "} ${label.padEnd(34)} 実際=${JSON.stringify(a)} 期待=${JSON.stringify(b)}`);
};

console.log("══ 段1: 算定・単位数 (手計算した期待値と突合) ══");
const res = await aggregateBathVisitSeikyu(sb, {
  officeId: OFFICE_ID, tenantId: "kt-group", year: Y, month: M, unitPrice: UNIT_PRICE,
});
const rows = res.rows as unknown as Array<Record<string, unknown>>;
console.log(`  【分母】集計行 ${rows.length} 件 (期待 ${Object.keys(EXPECT).length} 件)`);
if (rows.length === 0) {
  console.log("  ⚠ 分母 0 — サンプル未投入。**合格とは言わない**。");
  console.log("     node migrations/seed_sample_bath_c.mjs --execute で投入してください");
  process.exit(0);
}

for (const [no, e] of Object.entries(EXPECT)) {
  const r = rows.find((x) => String(x.user_name ?? "").startsWith(e.name)) as Record<string, number | string> | undefined;
  console.log(`\n  ── ${no} ${e.name} (${e.level} / ${e.copay}割 / 限度 ${e.limit.toLocaleString()}) ──`);
  if (!r) { ng++; checked++; console.log("    NG  集計行が見つからない"); continue; }
  const total = Number(r.totalUnits);
  const over = Number(r.overUnits ?? 0);
  const cost = Number(r.totalAmount);
  const ins = Number(r.insuranceAmount);
  const user = Number(r.userAmount);
  const self = Number(r.selfPayAmount ?? 0);
  eq("総単位 (保険給付対象)", total, e.base);
  eq("限度額超過の単位", over, e.over);
  eq("限度額 (認定から)", Number(r.limitUnits), e.limit);
  // 金額: 費用額 = floor(単位 × 単価)
  const expCost = Math.floor((e.base * Math.round(UNIT_PRICE * 100)) / 100);
  eq("費用額 = floor(単位×単価)", cost, expCost);
  const expIns = Math.floor((expCost * (10 - e.copay)) / 10);
  eq(`保険 = floor(費用×${10 - e.copay}/10)`, ins, expIns);
  eq("恒等式 費用 = 保険+公費+本人", cost, ins + Number(r.kohiAmount ?? 0) + Number(r.kohi2Amount ?? 0) + user);
  if (e.over > 0) {
    const expSelf = Math.floor((e.over * Math.round(UNIT_PRICE * 100)) / 100);
    eq("超過の全額自費 = floor(超過単位×単価)", self, expSelf);
  } else eq("超過なしなら自費 0", self, 0);
}

console.log(`\n  段1: 検査 ${checked} 件 / NG ${ng} 件`);
if (res.warnings?.length) {
  console.log(`\n  集計 warning ${res.warnings.length} 件:`);
  for (const w of res.warnings.slice(0, 10)) console.log(`     - ${w}`);
}

// ══ 段2: 伝送様式 ═══════════════════════════════════════════════════════
console.log("\n══ 段2: 伝送様式 ══");
try {
  const mod = await import("@/lib/kokuho-densou/build");
  const names = Object.keys(mod).filter((k) => /^build/i.test(k));
  console.log(`  伝送 builder の export: ${names.join(", ") || "(build* が無い)"}`);
  console.log("  ⚠ ここから先は builder の入力形に合わせて組む。次の実行で埋める。");
} catch (e) {
  console.log(`  ⚠ builder を読めない: ${(e as Error).message}`);
}
