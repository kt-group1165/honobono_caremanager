/**
 * 区分支給限度基準額 (限度額) 超過計算の検証
 *
 *   npx tsx scripts/gendo-verify.mts
 *
 * migrations/seed_fake_gendo_test.mjs で投入したテスト事業所 (2026-11) を
 * aggregateMonthlyVisitSeikyu で集計し、**手計算した期待値**と突合する。
 *
 * 期待値は下の EXPECTED に literal で書いてある (集計側の式を再実装していない)。
 * 計算根拠 (単価 11.05 円 / 1割 or 2割):
 *   総額     = floor(総単位数 × 1105 / 100)
 *   保険     = floor(総額 × (10 − 負担割合×10) / 10)
 *   利用者   = 総額 − 保険 − 公費
 *   超過自費 = floor(超過単位 × 1105 / 100)     ※ 負担割合に関係なく 10 割
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { aggregateMonthlyVisitSeikyu, type UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";

const META = JSON.parse(
  readFileSync(new URL("../migrations/_fake_gendo_test_meta.json", import.meta.url), "utf8"),
) as {
  marker: string; month: string; officeId: string; unitPrice: number; tenantId: string;
  cases: { tag: string; clientId: string; level: string; copay: string; limit: string; gross: number; visits: number; memo: string }[];
};

const env: Record<string, string> = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
  if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface Exp {
  limitUnits: number | null;
  grossBaseUnits: number;
  overUnits: number;
  baseUnits: number;
  addonUnits: number;
  totalUnits: number;
  totalAmount: number;
  insuranceAmount: number;
  userAmount: number;
  kohiAmount: number | null;
  selfPayAmount: number;
  careLevel?: string;
  overSource?: "auto" | "manual";
}

/** Run A: 処遇改善加算なし (appliedFormulaCodes = []) — 手計算値 */
const EXPECTED_A: Record<string, Exp> = {
  // 要介護1 限度額 16765 の境界 3 点
  G01: { limitUnits: 16765, grossBaseUnits: 16764, overUnits: 0, baseUnits: 16764, addonUnits: 0, totalUnits: 16764, totalAmount: 185242, insuranceAmount: 166717, userAmount: 18525, kohiAmount: null, selfPayAmount: 0 },
  G02: { limitUnits: 16765, grossBaseUnits: 16765, overUnits: 0, baseUnits: 16765, addonUnits: 0, totalUnits: 16765, totalAmount: 185253, insuranceAmount: 166727, userAmount: 18526, kohiAmount: null, selfPayAmount: 0 },
  G03: { limitUnits: 16765, grossBaseUnits: 16766, overUnits: 1, baseUnits: 16765, addonUnits: 0, totalUnits: 16765, totalAmount: 185253, insuranceAmount: 166727, userAmount: 18526, kohiAmount: null, selfPayAmount: 11 },
  // 要介護2 ちょうど / 要介護3 +1 / 要介護4 大幅 / 要介護5 ちょうど
  G04: { limitUnits: 19705, grossBaseUnits: 19705, overUnits: 0, baseUnits: 19705, addonUnits: 0, totalUnits: 19705, totalAmount: 217740, insuranceAmount: 195966, userAmount: 21774, kohiAmount: null, selfPayAmount: 0 },
  G05: { limitUnits: 27048, grossBaseUnits: 27049, overUnits: 1, baseUnits: 27048, addonUnits: 0, totalUnits: 27048, totalAmount: 298880, insuranceAmount: 268992, userAmount: 29888, kohiAmount: null, selfPayAmount: 11 },
  G06: { limitUnits: 30938, grossBaseUnits: 33500, overUnits: 2562, baseUnits: 30938, addonUnits: 0, totalUnits: 30938, totalAmount: 341864, insuranceAmount: 307677, userAmount: 34187, kohiAmount: null, selfPayAmount: 28310 },
  G07: { limitUnits: 36217, grossBaseUnits: 36217, overUnits: 0, baseUnits: 36217, addonUnits: 0, totalUnits: 36217, totalAmount: 400197, insuranceAmount: 360177, userAmount: 40020, kohiAmount: null, selfPayAmount: 0 },
  // 月途中の区分変更 (要介護1→3): 限度額は重い方 27048、要介護度は月末時点 = 要介護3
  G08: { limitUnits: 27048, grossBaseUnits: 25000, overUnits: 0, baseUnits: 25000, addonUnits: 0, totalUnits: 25000, totalAmount: 276250, insuranceAmount: 248625, userAmount: 27625, kohiAmount: null, selfPayAmount: 0, careLevel: "要介護3" },
  // 公費併用 + 超過 295 単位
  G09: { limitUnits: 19705, grossBaseUnits: 20000, overUnits: 295, baseUnits: 19705, addonUnits: 0, totalUnits: 19705, totalAmount: 217740, insuranceAmount: 195966, userAmount: 0, kohiAmount: 21774, selfPayAmount: 3259 },
  G10: { limitUnits: 19705, grossBaseUnits: 20000, overUnits: 295, baseUnits: 19705, addonUnits: 0, totalUnits: 19705, totalAmount: 217740, insuranceAmount: 195966, userAmount: 5000, kohiAmount: 16774, selfPayAmount: 3259 },
  // 計画単位数優先 / 限度額未登録 / 限度額誤登録 / 2割負担
  G11: { limitUnits: 10500, grossBaseUnits: 12000, overUnits: 1500, baseUnits: 10500, addonUnits: 0, totalUnits: 10500, totalAmount: 116025, insuranceAmount: 104422, userAmount: 11603, kohiAmount: null, selfPayAmount: 16575 },
  G12: { limitUnits: null, grossBaseUnits: 12000, overUnits: 0, baseUnits: 12000, addonUnits: 0, totalUnits: 12000, totalAmount: 132600, insuranceAmount: 119340, userAmount: 13260, kohiAmount: null, selfPayAmount: 0 },
  G13: { limitUnits: 16765, grossBaseUnits: 33500, overUnits: 16735, baseUnits: 16765, addonUnits: 0, totalUnits: 16765, totalAmount: 185253, insuranceAmount: 166727, userAmount: 18526, kohiAmount: null, selfPayAmount: 184921 },
  G14: { limitUnits: 30938, grossBaseUnits: 33500, overUnits: 2562, baseUnits: 30938, addonUnits: 0, totalUnits: 30938, totalAmount: 341864, insuranceAmount: 273491, userAmount: 68373, kohiAmount: null, selfPayAmount: 28310 },
  // ⚠ 計画単位数 30000 > 認定限度額 16765。現仕様は計画単位数を無条件で基準値にするので超過 0
  G15: { limitUnits: 30000, grossBaseUnits: 20000, overUnits: 0, baseUnits: 20000, addonUnits: 0, totalUnits: 20000, totalAmount: 221000, insuranceAmount: 198900, userAmount: 22100, kohiAmount: null, selfPayAmount: 0 },
  // ケアマネ手割振り (別表) 優先。機械判定なら超過 0 のところを 1000 単位自費にする
  G16: { limitUnits: 27048, grossBaseUnits: 12000, overUnits: 1000, baseUnits: 11000, addonUnits: 0, totalUnits: 11000, totalAmount: 121550, insuranceAmount: 109395, userAmount: 12155, kohiAmount: null, selfPayAmount: 11050, overSource: "manual" },
  // 公費単独 (被保番 H 始まり): 保険 0 円・全額公費。超過分だけは 10 割自費で分離される
  G17: { limitUnits: 19705, grossBaseUnits: 20000, overUnits: 295, baseUnits: 19705, addonUnits: 0, totalUnits: 19705, totalAmount: 217740, insuranceAmount: 0, userAmount: 0, kohiAmount: 217740, selfPayAmount: 3259 },
};

/** Run B: 訪問介護処遇改善加算Ⅰ１ (116275 = 270/1000) — 一部ケースのみ手計算 */
const ADDON_CODE = "116275";
const EXPECTED_B: Record<string, Exp> = {
  G04: { limitUnits: 19705, grossBaseUnits: 19705, overUnits: 0, baseUnits: 19705, addonUnits: 5320, totalUnits: 25025, totalAmount: 276526, insuranceAmount: 248873, userAmount: 27653, kohiAmount: null, selfPayAmount: 0 },
  G05: { limitUnits: 27048, grossBaseUnits: 27049, overUnits: 1, baseUnits: 27048, addonUnits: 7303, totalUnits: 34351, totalAmount: 379578, insuranceAmount: 341620, userAmount: 37958, kohiAmount: null, selfPayAmount: 11 },
  G06: { limitUnits: 30938, grossBaseUnits: 33500, overUnits: 2562, baseUnits: 30938, addonUnits: 8353, totalUnits: 39291, totalAmount: 434165, insuranceAmount: 390748, userAmount: 43417, kohiAmount: null, selfPayAmount: 28310 },
  G10: { limitUnits: 19705, grossBaseUnits: 20000, overUnits: 295, baseUnits: 19705, addonUnits: 5320, totalUnits: 25025, totalAmount: 276526, insuranceAmount: 248873, userAmount: 5000, kohiAmount: 22653, selfPayAmount: 3259 },
};

const tagByClient = new Map(META.cases.map((c) => [c.clientId, c.tag]));
let fails = 0;
const FIELDS: (keyof Exp)[] = [
  "limitUnits", "grossBaseUnits", "overUnits", "baseUnits", "addonUnits",
  "totalUnits", "totalAmount", "insuranceAmount", "userAmount", "kohiAmount", "selfPayAmount",
];

function compare(runLabel: string, tag: string, row: UserSeikyuRow, exp: Exp): void {
  const got: Record<string, number | null> = {
    limitUnits: row.limitUnits, grossBaseUnits: row.grossBaseUnits, overUnits: row.overUnits,
    baseUnits: row.baseUnits, addonUnits: row.addonUnits, totalUnits: row.totalUnits,
    totalAmount: row.totalAmount, insuranceAmount: row.insuranceAmount,
    userAmount: row.userAmount, kohiAmount: row.kohiAmount, selfPayAmount: row.selfPayAmount,
  };
  const diffs: string[] = [];
  for (const f of FIELDS) {
    const e = exp[f] as number | null;
    if (got[f] !== e) diffs.push(`${f}: 実測=${got[f]} 期待=${e} (差 ${(got[f] ?? 0) - (e ?? 0)})`);
  }
  if (exp.careLevel && row.care_level !== exp.careLevel) {
    diffs.push(`care_level: 実測=${row.care_level} 期待=${exp.careLevel}`);
  }
  if (exp.overSource && row.overSource !== exp.overSource) {
    diffs.push(`overSource: 実測=${row.overSource} 期待=${exp.overSource}`);
  }
  // 恒等式: 総額 = 保険 + 公費1 + 公費2 + 利用者負担
  const idLhs = row.totalAmount;
  const idRhs = row.insuranceAmount + (row.kohiAmount ?? 0) + (row.kohi2Amount ?? 0) + row.userAmount;
  if (idLhs !== idRhs) diffs.push(`恒等式: 総額${idLhs} != 保険+公費+負担${idRhs}`);
  // overAmount と selfPayAmount は同値であるべき
  if (row.overAmount !== row.selfPayAmount) diffs.push(`overAmount(${row.overAmount}) != selfPayAmount(${row.selfPayAmount})`);
  // baseUnits = grossBaseUnits - overUnits
  if (row.baseUnits !== row.grossBaseUnits - row.overUnits) diffs.push(`baseUnits != gross - over`);

  if (diffs.length === 0) {
    console.log(`  一致 [OK] ${runLabel} ${tag}`);
  } else {
    fails++;
    console.log(`  不一致 [NG] ${runLabel} ${tag}`);
    for (const d of diffs) console.log(`      ${d}`);
  }
}

async function run(label: string, formulaCodes: string[], expected: Record<string, Exp>) {
  const [y, m] = META.month.split("-").map(Number);
  const res = await aggregateMonthlyVisitSeikyu(sb, {
    officeId: META.officeId, tenantId: META.tenantId, year: y, month: m,
    unitPrice: META.unitPrice, appliedFormulaCodes: formulaCodes,
  });
  console.log(`\n[${label}] 集計 ${res.rows.length} 行 / warning ${res.warnings.length} 件`);
  const byTag = new Map<string, UserSeikyuRow>();
  for (const r of res.rows) {
    const tag = tagByClient.get(r.user_id);
    if (tag) byTag.set(tag, r);
  }
  for (const tag of Object.keys(expected)) {
    const row = byTag.get(tag);
    if (!row) { fails++; console.log(`  不一致 [NG] ${label} ${tag}: 集計行が出ていない`); continue; }
    compare(label, tag, row, expected[tag]);
  }
  return res;
}

async function main() {
  console.log(`限度額検証 — office=${META.officeId} month=${META.month} 単価=${META.unitPrice}`);
  const a = await run("加算なし", [], EXPECTED_A);
  const b = await run(`処遇改善Ⅰ１(${ADDON_CODE})`, [ADDON_CODE], EXPECTED_B);

  // 超過自費は %加算の有無で変わらないこと (全ケース)
  console.log("\n[超過自費が処遇改善加算で変わらないこと]");
  const aBy = new Map(a.rows.map((r) => [tagByClient.get(r.user_id) ?? r.user_id, r]));
  let mismatched = 0;
  for (const r of b.rows) {
    const tag = tagByClient.get(r.user_id) ?? r.user_id;
    const ra = aBy.get(tag);
    if (!ra) continue;
    if (ra.selfPayAmount !== r.selfPayAmount || ra.overUnits !== r.overUnits) {
      mismatched++; fails++;
      console.log(`  不一致 [NG] ${tag}: 加算なし over=${ra.overUnits}/${ra.selfPayAmount}円 vs 加算あり over=${r.overUnits}/${r.selfPayAmount}円`);
    }
  }
  if (mismatched === 0) console.log(`  一致 [OK] 全 ${b.rows.length} 行で超過単位・超過自費が同一`);

  // 警告の確認
  console.log("\n[警告]");
  for (const w of a.warnings) console.log(`  - ${w}`);

  console.log(`\n${fails === 0 ? "PASS — 全項目一致" : `FAIL — ${fails} 件不一致`}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
