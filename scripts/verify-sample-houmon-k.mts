// ⚠ 調査用・常設でない (2026-09-05 分類)。ZK### サンプル (SAMPLE_DATA_PROTOCOL 5章) が
//   DB に投入されていないと「対象実績0件」で終わる (現在は撤去済)。
//
// 段1: 訪問介護サンプル (ZK###) の単位数を **手計算した期待値** と突合する。
//
//   npx tsx scripts/verify-sample-houmon-k.mts
//
// ⚠ 期待値はマスタを引かずに告示の基本単位から組んである (VERIFICATION_RULES 3-2)。
//   マスタが誤っていれば差が出るのが正しい。
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { aggregateMonthlyVisitSeikyu } from "../src/lib/visit-seikyu/aggregate";

const env: Record<string, string> = {};
for (const l of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const OFFICE_BN = "1270501180";
const LIMIT: Record<string, number> = {
  要介護1: 16765, 要介護2: 19705, 要介護3: 27048, 要介護4: 30938, 要介護5: 36217,
};
/** ★ 手計算。seed script の UNITS と同じ根拠 (告示の基本単位) */
const EXPECT: Record<string, { level: string; units: number; note: string }> = {
  ZK001: { level: "要介護1", units: 244 * 10 + 309 * 4, note: "限度額内・基本" },
  ZK002: { level: "要介護2", units: 387 * 12 + 517 * 6, note: "2割負担" },
  ZK003: { level: "要介護3", units: 567 * 40 + 649 * 12, note: "★ 限度額超過" },
  ZK004: { level: "要介護5", units: 305 * 8 + 366 * 4 + 488 * 6, note: "夜間・深夜・2人" },
  ZK005: { level: "要介護1", units: 97 * 8 + 244 * 4, note: "通院等乗降介助" },
  ZK006: { level: "要介護4", units: 1288, note: "★ 身体９系 315分 → 1288 (基準1124ではない)" },
};

const { data: offs, error: oe } = await sb
  .from("offices").select("id, name, unit_price").eq("business_number", OFFICE_BN).limit(1);
if (oe) throw new Error(`事業所取得に失敗: ${oe.message}`);
if (!offs?.length) throw new Error(`事業所 ${OFFICE_BN} が見つかりません`);
const office = offs[0];

const result = await aggregateMonthlyVisitSeikyu(sb as never, {
  officeId: office.id as string,
  tenantId: "kt-group",
  year: 2026,
  month: 12,
});
const rows = result.rows;
console.log(`集計: 対象実績 ${result.recordCount} 件 / 行 ${rows.length}`);

type Row = {
  user_number: string | null; user_name: string | null; care_level: string | null;
  baseUnits: number; addonUnits: number; totalUnits: number; overUnits: number;
  grossBaseUnits: number; limitUnits: number | null;
};
const mine = (rows as unknown as Row[]).filter((r) => /^ZK\d+$/.test(String(r.user_number ?? "")));
console.log(`集計が返した行 ${rows.length} / うちサンプル(k) ${mine.length}  ← 分母`);
if (mine.length === 0) {
  console.log("★ 分母 0 = 測れていない。合格判定を出さない。");
  console.log("   参考: 返った行の user_number:",
    (rows as unknown as Row[]).map((r) => r.user_number).join(" / "));
  process.exit(1);
}

// ⚠ totalUnits は **加算込み**。手計算の期待値と突き合わせるのは grossBaseUnits (実績の素の単位)。
let pass = 0;
const fail: string[] = [];
for (const [key, exp] of Object.entries(EXPECT)) {
  const r = mine.find((x) => x.user_number === key);
  if (!r) { fail.push(`${key}: 集計に出てこない`); continue; }
  const limit = LIMIT[exp.level];
  const expOver = Math.max(0, exp.units - limit);
  const okUnits = r.grossBaseUnits === exp.units;
  const okOver = r.overUnits === expOver;
  const okLimit = r.limitUnits === limit;
  if (okUnits && okOver && okLimit) { pass++; continue; }
  fail.push(
    `${key} ${exp.level} (${exp.note})\n` +
      `     実績の素の単位  期待 ${exp.units} / 実際 ${r.grossBaseUnits}${okUnits ? "" : `   ★差 ${r.grossBaseUnits - exp.units}`}\n` +
      `     限度額超過      期待 ${expOver} / 実際 ${r.overUnits}\n` +
      `     区分支給限度額  期待 ${limit} / 実際 ${r.limitUnits}`,
  );
}
console.log(`\n合格 ${pass} / ${Object.keys(EXPECT).length}`);
for (const f of fail) console.log("★ " + f);

// 加算の内訳も出す (恒等式: total = base + addon)
console.log(`\n加算の内訳 (恒等式 totalUnits = baseUnits + addonUnits)`);
for (const r of mine.sort((a, b) => String(a.user_number).localeCompare(String(b.user_number)))) {
  const ok = r.totalUnits === r.baseUnits + r.addonUnits;
  const rate = r.baseUnits ? ((r.addonUnits / r.baseUnits) * 100).toFixed(2) : "-";
  console.log(`  ${r.user_number} 素 ${String(r.grossBaseUnits).padStart(6)} → 保険対象 ${String(r.baseUnits).padStart(6)}` +
    ` + 加算 ${String(r.addonUnits).padStart(5)} (${rate}%) = ${String(r.totalUnits).padStart(6)}  ${ok ? "✓" : "★恒等式が崩れている"}`);
}
console.log("\n⚠ この検証が証明していないこと: 伝送様式 (段2)・公費・利用者負担額・加算率の妥当性。");
