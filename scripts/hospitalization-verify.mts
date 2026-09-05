/**
 * 入退院 (hospitalization.ts) の純関数部分の検証 (DB 不使用)
 *
 *   npx tsx scripts/hospitalization-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   isHospitalizedOn/hospitalizationsInRange/isCurrentlyHospitalized は
 *   2026-07-08 の入退院連動機能の中核だが、1つも検証されていなかった
 *   (grep で "hospitalization" という語が別ファイルの無関係な用途 — 入院時
 *   情報連携加算の resolved.hospitalization フィールド — にヒットしていた
 *   だけで、この module 自体は未検証と判明)。
 *
 *   ★ 境界値が多い: 入院日当日/退院日当日の扱い、退院日未定(入院中)、
 *   期間の重なり判定。SESSION_START の入院等(127xxx)判定材料が無い件とも
 *   関連する基盤モジュールなので、境界を正しく固定化しておく価値が高い。
 */
import {
  isHospitalizedOn,
  hospitalizationsInRange,
  isCurrentlyHospitalized,
  type HospitalizationPeriod,
} from "@/lib/hospitalization";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

const period = (o: Partial<HospitalizationPeriod> & { admission_date: string }): HospitalizationPeriod => ({
  discharge_date: null,
  hospital_name: null,
  ...o,
});

// ── isHospitalizedOn ──────────────────────────────────────────────────────
eq("periods が undefined → null", isHospitalizedOn(undefined, "2026-06-15"), null);
eq("空配列 → null", isHospitalizedOn([], "2026-06-15"), null);
{
  const p = [period({ admission_date: "2026-06-01", discharge_date: "2026-06-10" })];
  eq("★ 入院日当日は入院中 (境界含む)", isHospitalizedOn(p, "2026-06-01"), p[0]);
  eq("入院期間内は入院中", isHospitalizedOn(p, "2026-06-05"), p[0]);
  eq("★ 退院日当日は「退院済み」扱い (入院中ではない)", isHospitalizedOn(p, "2026-06-10"), null);
  eq("退院日前日は入院中", isHospitalizedOn(p, "2026-06-09"), p[0]);
  eq("入院日前日は入院中でない", isHospitalizedOn(p, "2026-05-31"), null);
  eq("退院日以降は入院中でない", isHospitalizedOn(p, "2026-06-11"), null);
}
{
  // discharge_date=null (退院日未定=まだ入院中)
  const p = [period({ admission_date: "2026-06-01", discharge_date: null })];
  eq("★ discharge_date が null (退院未定) は将来もずっと入院中扱い", isHospitalizedOn(p, "2030-01-01"), p[0]);
  eq("入院日より前は入院中でない", isHospitalizedOn(p, "2026-05-31"), null);
}
{
  // 複数期間 (過去の入院履歴 + 現在の入院)
  const past = period({ admission_date: "2026-01-01", discharge_date: "2026-01-10" });
  const current = period({ admission_date: "2026-06-01", discharge_date: null });
  eq("★ 複数期間から該当するものを正しく選ぶ (過去の入院に引っかからない)", isHospitalizedOn([past, current], "2026-06-05"), current);
  eq("どの期間にも該当しない日は null", isHospitalizedOn([past, current], "2026-03-01"), null);
}

// ── hospitalizationsInRange ───────────────────────────────────────────────
{
  const p = [period({ admission_date: "2026-06-10", discharge_date: "2026-06-20" })];
  eq("★ 完全に範囲内は重なりあり", hospitalizationsInRange(p, "2026-06-01", "2026-06-30"), p);
  eq("★ 範囲の一部だけ重なる (入院開始が範囲末に一致) も重なりあり (境界含む)", hospitalizationsInRange(p, "2026-06-01", "2026-06-10"), p);
  eq("★ 範囲の一部だけ重なる (退院日が範囲始に一致) も重なりあり (境界含む)", hospitalizationsInRange(p, "2026-06-20", "2026-06-30"), p);
  eq("完全に範囲外 (前) は重なりなし", hospitalizationsInRange(p, "2026-05-01", "2026-06-09"), []);
  eq("完全に範囲外 (後) は重なりなし", hospitalizationsInRange(p, "2026-06-21", "2026-06-30"), []);
  eq("undefined は空配列", hospitalizationsInRange(undefined, "2026-06-01", "2026-06-30"), []);
}
{
  // discharge_date=null (入院中) は「未来まで続く」扱いなので、範囲が入院開始より後ろにあっても重なる
  const p = [period({ admission_date: "2026-06-01", discharge_date: null })];
  eq("★ 退院日未定の入院は、範囲が入院開始より後 (将来) でも重なりありと判定する", hospitalizationsInRange(p, "2030-01-01", "2030-01-31"), p);
}

// ── isCurrentlyHospitalized ───────────────────────────────────────────────
eq("入院中なら true", isCurrentlyHospitalized([period({ admission_date: "2026-06-01", discharge_date: null })], "2026-06-15"), true);
eq("退院済みなら false", isCurrentlyHospitalized([period({ admission_date: "2026-06-01", discharge_date: "2026-06-10" })], "2026-06-15"), false);
eq("入院履歴なし (undefined) なら false", isCurrentlyHospitalized(undefined, "2026-06-15"), false);

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① 退院日当日を「まだ入院中」と誤判定する壊れた実装 (< を <= にする)
  const p = [period({ admission_date: "2026-06-01", discharge_date: "2026-06-10" })];
  const correct = isHospitalizedOn(p, "2026-06-10");
  const broken = (() => {
    for (const x of p) {
      if ("2026-06-10" >= x.admission_date && (x.discharge_date === null || "2026-06-10" <= x.discharge_date)) return x; // ★ <= にする (正は <)
    }
    return null;
  })();
  const detected1 = correct !== broken;
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: 退院日境界(< vs <=)の違いを検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ 退院日当日をまだ入院中と誤判定するバグを検出できる (正=${JSON.stringify(correct)} / 壊れた版=${JSON.stringify(broken)})`);

  // ② discharge_date=null を「入院期間なし」と誤扱いする壊れた実装
  const p2 = [period({ admission_date: "2026-06-01", discharge_date: null })];
  const correct2 = hospitalizationsInRange(p2, "2030-01-01", "2030-01-31");
  const broken2 = p2.filter((x) => x.admission_date <= "2030-01-31" && x.discharge_date !== null && x.discharge_date >= "2030-01-01"); // ★ null チェックを落として除外してしまう
  const detected2 = correct2.length !== broken2.length;
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: discharge_date=null(入院中)の扱いの違いを検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ 退院日未定(入院中)を将来の範囲判定から誤って除外するバグを検出できる (正=${correct2.length}件 / 壊れた版=${broken2.length}件)`);
}

console.log(`\n入退院 (純関数部分) の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
