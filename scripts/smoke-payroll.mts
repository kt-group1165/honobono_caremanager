/**
 * パート給与 計算の回帰スモーク (純関数・DB不要・決定論的)。
 *   npm run smoke:payroll
 * 固定入力 → 固定期待値。calcPartTimePayroll (時給×実働) を触ったら回す。
 */
import {
  calcPartTimePayroll,
  commAllowanceFor,
  minutesBetween,
  type PartTimeVisit,
  type WageCategory,
} from "@/lib/kaigo-payroll/part-time";

let fail = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    console.log(`  [OK] ${label}`);
  } else {
    fail++;
    console.error(`  [NG] ${label}\n     got : ${g}\n     want: ${w}`);
  }
}

// ── minutesBetween ──
eq("minutesBetween 09:00-10:30 = 90", minutesBetween("09:00", "10:30"), 90);
eq("minutesBetween 09:00-09:20 = 20", minutesBetween("09:00", "09:20"), 20);
eq("minutesBetween 日跨ぎ 23:30-00:30 = 60", minutesBetween("23:30", "00:30"), 60);
eq("minutesBetween null = 0", minutesBetween(null, "10:00"), 0);

// ── calcPartTimePayroll ──
const categories: WageCategory[] = [
  { id: "cat-body", name: "身体介護", hourlyRate: 1500 },
  { id: "cat-life", name: "生活援助", hourlyRate: 1200 },
];
const mappings = [
  { serviceType: "身体日１．０", categoryId: "cat-body" },
  { serviceType: "家事日１．０", categoryId: "cat-life" },
  { serviceType: "未設定サービス", categoryId: null }, // 明示的に未割当
];
const visits: PartTimeVisit[] = [
  { staffId: "s1", staffName: "板垣", staffNameKana: "いたがき", serviceType: "身体日１．０", minutes: 60, date: "2026-07-01" }, // 1500
  { staffId: "s1", staffName: "板垣", staffNameKana: "いたがき", serviceType: "家事日１．０", minutes: 45, date: "2026-07-02" }, // round(0.75*1200)=900
  { staffId: "s1", staffName: "板垣", staffNameKana: "いたがき", serviceType: "身体日１．０", minutes: 30, date: "2026-07-03" }, // round(0.5*1500)=750
  { staffId: "s2", staffName: "太田", staffNameKana: "おおた", serviceType: "身体日１．０", minutes: 90, date: "2026-07-01" }, // round(1.5*1500)=2250
  { staffId: "s2", staffName: "太田", staffNameKana: "おおた", serviceType: "謎サービス", minutes: 60, date: "2026-07-02" }, // 未マッピング
];

const r = calcPartTimePayroll(visits, mappings, categories);

eq("s1 totalPay = 1500+900+750 = 3150", r.byStaff.find((x) => x.staffId === "s1")?.totalPay, 3150);
eq("s1 totalMinutes = 135", r.byStaff.find((x) => x.staffId === "s1")?.totalMinutes, 135);
eq("s2 totalPay = 2250 (謎は除外)", r.byStaff.find((x) => x.staffId === "s2")?.totalPay, 2250);
eq("s2 unmappedCount = 1", r.byStaff.find((x) => x.staffId === "s2")?.unmappedCount, 1);
eq("s2 unmappedMinutes = 60", r.byStaff.find((x) => x.staffId === "s2")?.unmappedMinutes, 60);
eq("grandTotalPay = 3150+2250 = 5400", r.grandTotalPay, 5400);
eq("grandTotalMinutes = 135+150 = 285", r.grandTotalMinutes, 285);
eq("unmappedServiceTypes = [謎サービス]", r.unmappedServiceTypes, ["謎サービス"]);
eq("並び順 五十音 (板垣→太田)", r.byStaff.map((x) => x.staffName), ["板垣", "太田"]);

// 手当なし (opts 省略) は grossTotal = totalPay
eq("手当省略時 s1 grossTotal = totalPay", r.byStaff.find((x) => x.staffId === "s1")?.grossTotal, 3150);
eq("手当省略時 grandGross = grandTotalPay", r.grandGross, 5400);

// ── 手当あり ──
// s1: 実働135分(<50h) 社保未加入 → 通信500。キャンセル2件×1000=2000。gross=3150+2500=5650
// s2: 実働150分 社保加入 → 通信0。キャンセル0。gross=2250
// s3: 訪問実績なし・キャンセル1件のみ (社保未加入) → cancel1000 + 通信0(実働0) = gross1000
const ra = calcPartTimePayroll(visits, mappings, categories, {
  cancelUnitPrice: 1000,
  cancelCountByStaff: new Map([
    ["s1", 2],
    ["s3", 1],
  ]),
  socialInsuranceByStaff: new Map([
    ["s1", false],
    ["s2", true],
  ]),
  staffRoster: new Map([["s3", { name: "新人", kana: "しんじん" }]]),
});
const a1 = ra.byStaff.find((x) => x.staffId === "s1");
const a2 = ra.byStaff.find((x) => x.staffId === "s2");
const a3 = ra.byStaff.find((x) => x.staffId === "s3");
eq("s1 commAllowance = 500 (未加入/135分)", a1?.commAllowance, 500);
eq("s1 cancelAllowance = 2*1000 = 2000", a1?.cancelAllowance, 2000);
eq("s1 grossTotal = 3150+2000+500 = 5650", a1?.grossTotal, 5650);
eq("s2 commAllowance = 0 (社保加入)", a2?.commAllowance, 0);
eq("s2 grossTotal = 2250", a2?.grossTotal, 2250);
eq("s3 訪問無しでもキャンセルで行に出る", a3?.staffName, "新人");
eq("s3 cancelAllowance = 1000", a3?.cancelAllowance, 1000);
eq("s3 commAllowance = 0 (実働0)", a3?.commAllowance, 0);
eq("s3 grossTotal = 1000", a3?.grossTotal, 1000);
eq("grandCancelAllowance = 2000+1000 = 3000", ra.grandCancelAllowance, 3000);
eq("grandCommAllowance = 500", ra.grandCommAllowance, 500);
eq("grandGross = 5650+2250+1000 = 8900", ra.grandGross, 8900);

// 通信手当 50h境界 (ちょうど50h=3000分 は 500、50h超 は 1000)
eq("通信 50h ちょうど = 500", commAllowanceFor(false, 50 * 60), 500);
eq("通信 50h超 = 1000", commAllowanceFor(false, 50 * 60 + 1), 1000);
eq("通信 0分 = 0", commAllowanceFor(false, 0), 0);
eq("通信 社保加入 = 0", commAllowanceFor(true, 9999), 0);

if (fail === 0) {
  console.log("\nPASS — パート給与 計算スモーク 全一致");
  process.exit(0);
} else {
  console.error(`\nFAIL — ${fail} 件不一致`);
  process.exit(1);
}
