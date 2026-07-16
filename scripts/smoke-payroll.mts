/**
 * パート給与 計算の回帰スモーク (純関数・DB不要・決定論的)。
 *   npm run smoke:payroll
 * 固定入力 → 固定期待値。calcPartTimePayroll (時給×実働) を触ったら回す。
 */
import {
  calcPartTimePayroll,
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

if (fail === 0) {
  console.log("\nPASS — パート給与 計算スモーク 全一致");
  process.exit(0);
} else {
  console.error(`\nFAIL — ${fail} 件不一致`);
  process.exit(1);
}
