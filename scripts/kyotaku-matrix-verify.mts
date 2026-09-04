/**
 * 請求個人設定マトリクス (居宅介護支援) の ★ 単位数組立 の検証 (DB 不使用・純関数)
 *
 *   npx tsx scripts/kyotaku-matrix-verify.mts
 *
 * ⚠ この計算は 2026-09-04 まで _kojin-settei.tsx (client component) の
 *   applyPatch の中にあり、★ ハーネスから呼べないので一度も検証されていなかった。
 *   同じ型の事故は idou-billing-lines.ts (加算が1行も出ない不具合に気づけなかった) /
 *   idou-billing-summary.ts で既に見つかっている。
 *
 * ★ 期待値は実装の出力からコピーしない。calcTotals の式 (claims-shared.ts コメント)
 *   と 2026-08-31 監査の記述 (「処遇改善加算 = 総単位数 × 率 (round)」) から手で計算する:
 *
 *     addUnits    = 初回300 + 特定事業所(claim既存) + 医療介護連携(claim既存) +
 *                   入院時情報連携(HOSPITAL_COORD_UNITS) + 退院退所(DISCHARGE_UNITS) +
 *                   通院時情報連携50 + ターミナル400 + 緊急時カンファ200
 *     reductionUnits = BCP減算 + 虐待防止減算 + 運営基準減算(50%)
 *                   (各々 round(所定×(100-pct)/100) を所定から引いた値。別々に計算して加算)
 *     subtotal    = units + addUnits - reductionUnits
 *     shoguu_units = 予防(46始まり)は常に0。居宅(43)は round(subtotal × permil / 1000)
 *     total_units  = subtotal + shoguu_units
 *     total_amount = floor(total_units × unit_price)   ← 端数は必ず利用者負担側 (CLAUDE.md 3.2)
 */
import {
  computeKyotakuMatrixUpdate,
  type KyotakuMatrixClaimInput,
  type KyotakuMatrixOfficeSettings,
} from "@/app/(authenticated)/billing/claims/claims-shared";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  OK   ${label}`); }
  else { fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`); console.log(`  FAIL ${label}\n         期待: ${JSON.stringify(want)}\n         実際: ${JSON.stringify(got)}`); }
};

/** 居宅3級地 (単価 11.05円) の基準claim。要介護1・2 = 432111 1086単位 */
const baseClaim = (over: Partial<KyotakuMatrixClaimInput> = {}): KyotakuMatrixClaimInput => ({
  units: 1086,
  unit_price: 11.05,
  care_support_code: "432111",
  tokutei_kassan_units: 0,
  medical_coop_kassan: false,
  medical_coop_kassan_units: 0,
  initial_addition: false,
  discharge_type: null,
  discharge_addition: false,
  hospital_coordination: false,
  hospital_coordination_units: 0,
  emergency_conference: false,
  unei_kijun_gensan: false,
  terminal_care: false,
  medical_coordination: false,
  bcp_not_prepared: false,
  bcp_reduction_pct: 0,
  abuse_prevention_not_implemented: false,
  abuse_reduction_pct: 0,
  shoguu_kaizen_code: null,
  ...over,
});
const officeOn: KyotakuMatrixOfficeSettings = { shoguuPermil: 21, shoguuCode: "436191" };
const officeOff: KyotakuMatrixOfficeSettings = { shoguuPermil: 0, shoguuCode: null };

console.log("=== §1 基準: 何も変えない (処遇改善のみ事業所設定から) ===");
{
  const r = computeKyotakuMatrixUpdate(baseClaim(), {}, officeOn);
  // subtotal=1086, shoguu=round(1086*21/1000)=round(22.806)=23, total=1109
  eq("処遇改善 round(1086×21/1000)=23単位", r.payload.shoguu_kaizen_units, 23);
  eq("総額 floor(1109×11.05)=12,254円", r.payload.total_amount, 12254);
  eq("保険請求額 = 総額 (10割給付)", r.payload.insurance_amount, r.payload.total_amount);
  eq("処遇改善コードは事業所設定のもの", r.payload.shoguu_kaizen_code, "436191");
}

console.log("\n=== §2 初回加算 300単位 ===");
{
  const r = computeKyotakuMatrixUpdate(baseClaim(), { initial: true }, officeOn);
  // subtotal=1086+300=1386, shoguu=round(1386*21/1000)=round(29.106)=29, total=1415
  eq("初回加算300が payload に反映", r.payload.initial_addition_units, 300);
  eq("処遇改善 round(1386×21/1000)=29単位", r.payload.shoguu_kaizen_units, 29);
  eq("総額 floor(1415×11.05)=15,635円", r.payload.total_amount, 15635);
}

console.log("\n=== §3 入院時情報連携Ⅰ (250単位) + 退院退所Ⅱロ (750単位) ===");
{
  const r = computeKyotakuMatrixUpdate(
    baseClaim(), { hospitalization: "i", discharge: "ii_ro" }, officeOff,
  );
  // subtotal = 1086 + 250 + 750 = 2086 (処遇改善は officeOff で 0)
  eq("入院時情報連携が250単位", r.payload.hospital_coordination_units, 250);
  eq("退院退所がii_ro=750単位", r.payload.discharge_addition_units, 750);
  eq("discharge_type に ii_ro を保存", r.payload.discharge_type, "ii_ro");
  eq("総額 floor(2086×11.05)=23,050円", r.payload.total_amount, 23050);
}

console.log("\n=== §4 運営基準減算 (50%) ===");
{
  const r = computeKyotakuMatrixUpdate(baseClaim(), { unei: true }, officeOn);
  // reductionUnitsOf(1086,50) = 1086 - round(1086*50/100) = 1086 - 543 = 543
  // subtotal = 1086 - 543 = 543, shoguu = round(543*21/1000) = round(11.403) = 11
  eq("運営基準減算 543単位", r.uneiKijunGensanUnits, 543);
  eq("uneiKijunGensan フラグが立つ", r.uneiKijunGensan, true);
  eq("処遇改善 round(543×21/1000)=11単位", r.payload.shoguu_kaizen_units, 11);
  eq("総額 floor(554×11.05)=6,121円", r.payload.total_amount, 6121);
}

console.log("\n=== §5 BCP未策定減算 + 虐待防止未実施減算 (独立に計算して加算) ===");
{
  const r = computeKyotakuMatrixUpdate(
    baseClaim({ bcp_not_prepared: true, bcp_reduction_pct: 1, abuse_prevention_not_implemented: true, abuse_reduction_pct: 1 }),
    {}, officeOff,
  );
  // reductionUnitsOf(1086,1) = 1086 - round(1086*99/100) = 1086 - round(1075.14) = 1086-1075=11 (各々)
  // ★ 2つは別々に reductionUnitsOf を通してから加算する (1つにまとめて計算しない)。
  //   reductionUnits = 11 + 11 = 22, subtotal = 1086-22 = 1064
  eq("総額 floor(1064×11.05)=11,757円", r.payload.total_amount, 11757);
}

console.log("\n=== §6 予防(46) は処遇改善が付かない (事業所設定に率があっても0) ===");
{
  const r = computeKyotakuMatrixUpdate(
    baseClaim({ units: 472, care_support_code: "462121", shoguu_kaizen_code: null }),
    {}, officeOn,
  );
  eq("予防コードでも officeOn.shoguuPermil=21 が渡されている", officeOn.shoguuPermil, 21);
  eq("処遇改善0単位 (46は付かない)", r.payload.shoguu_kaizen_units, 0);
  eq("処遇改善コードもnull", r.payload.shoguu_kaizen_code, null);
  eq("総額 floor(472×11.05)=5,215円", r.payload.total_amount, 5215);
}

console.log("\n=== §7 既存値からの解決 (patch未指定 = 既存claimの値を引き継ぐ) ===");
{
  // 入院時情報連携: 実績が250以上ならⅠ、未満ならⅡ
  const r1 = computeKyotakuMatrixUpdate(
    baseClaim({ hospital_coordination: true, hospital_coordination_units: 250 }), {}, officeOff,
  );
  eq("既存250単位はⅠとして解決される", r1.resolved.hospitalization, "i");
  const r2 = computeKyotakuMatrixUpdate(
    baseClaim({ hospital_coordination: true, hospital_coordination_units: 200 }), {}, officeOff,
  );
  eq("既存200単位はⅡとして解決される", r2.resolved.hospitalization, "ii");
  // 退院退所: discharge_type があればそれを優先。無ければ discharge_addition から i_ro 補完
  const r3 = computeKyotakuMatrixUpdate(
    baseClaim({ discharge_type: "iii", discharge_addition: true }), {}, officeOff,
  );
  eq("discharge_type があればそれを優先 (iii)", r3.resolved.discharge, "iii");
  const r4 = computeKyotakuMatrixUpdate(
    baseClaim({ discharge_type: null, discharge_addition: true }), {}, officeOff,
  );
  eq("discharge_type が無ければ i_ro に補完", r4.resolved.discharge, "i_ro");
}

console.log("\n=== §8 shoguu_kaizen_code の選択順 (事業所設定 → claim既存 → null) ===");
{
  const r1 = computeKyotakuMatrixUpdate(
    baseClaim({ shoguu_kaizen_code: "436192" }), {}, officeOn,
  );
  eq("事業所設定のコードが優先", r1.payload.shoguu_kaizen_code, "436191");
  const r2 = computeKyotakuMatrixUpdate(
    baseClaim({ shoguu_kaizen_code: "436192" }), {}, { shoguuPermil: 21, shoguuCode: null },
  );
  eq("事業所設定コードが無ければ claim 既存を使う", r2.payload.shoguu_kaizen_code, "436192");
}

console.log("\n=== §9 負のコントロール (期待値をわざと外して落ちることを確認) ===");
{
  const before = fails.length;
  eq("★ わざと誤った期待値 (13,000円) — 落ちるはず", 12254, 13000);
  const caught = fails.length === before + 1;
  if (caught) { console.log("  OK   検査は生きている (誤った期待値がFAILとして検出された)"); pass++; fails.pop(); }
  else { console.log("  ✗ 検査が動いていない — 誤った期待値がFAILしなかった"); fails.push("負のコントロールが機能しない"); }
}

console.log(`\n=== 結果: PASS ${pass} / FAIL ${fails.length} ===`);
if (fails.length > 0) { for (const f of fails) console.log(`  - ${f}`); process.exit(1); }
