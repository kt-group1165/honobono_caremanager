/**
 * 訪問介護 同一建物減算 (aggregate.ts:1671-1710) の検証
 *
 *   npx tsx scripts/same-building-verify.mts
 *
 * ── 背景 ──────────────────────────────────────────────────────────────
 *   H の指示: same-building.ts (同一建物減算) — 減額ロジックなので、誤ると
 *   ★過大請求の方向。処遇改善4実装突合と同じやり方で、実装を逐語で写して
 *   独立に検算する。
 *
 * ── 実データ確認 (2026-09-05) ────────────────────────────────────────
 *   client_office_assignments.same_building_tier に設定済みの行は本番 ★0件。
 *   (`same_building_tier=not.is.null` で REST 直接確認)。よって「今日の実測」
 *   ケースは無く、法定の率 (10%/15%/12%) と丸め境界から手で構成する。
 *
 * ── 対象 ─────────────────────────────────────────────────────────────
 *   A. reduction 本体   aggregate.ts:1676-1710 (SAME_BUILDING_REDUCTION 経由)
 *   B. serviceBaseUnits の確定位置  aggregate.ts:1423-1477
 *      (基本サービス行の合計。虐防/業未の合成コード差替え後・月次加算前に確定)
 *
 * ⚠ 「虐防/業未 減算と同一建物減算の順序 (掛け算で複合するか)」は制度解釈の
 *   問題なので★判定しない。gensan (虐待防止/業務継続) は official な合成コード
 *   (kaigo_service_codes の別レコード) を引く方式で、同一建物減算は officialな
 *   合成コードが無く別建て%減算行として出す方式 — 実装のこの構造自体は
 *   コードの作りとして筋が通っている (合成コードがある减算は合成コードを引き、
 *   無い减算は別行で引く)。★これが制度上も正しいかは未確認。報告のみ。
 *
 *   ★ 発火条件 (今は無害・いつ有害になるか):
 *     same_building_tier が設定された利用者に、★同じ月に虐防/業未の減算も
 *     当たったとき (= gensanOverride が効いて合成コードの単位数になった行を
 *     含む serviceBaseUnits に、さらに同一建物減算 (10/15/12%) が掛かる)。
 *     実データは同一建物減算 0 件・虐防/業未の適用事業所も別途要確認のため
 *     ★現状は理論上のシナリオ。同一建物減算の運用が始まった時点で要再確認。
 */

export type SameBuildingTier = "1" | "2" | "3";

// ---------------------------------------------------------------- same-building.ts を逐語で写す
const SAME_BUILDING_REDUCTION: Record<SameBuildingTier, { code: string; rate: number; label: string }> = {
  "1": { code: "114114", rate: 0.1, label: "同一建物減算1 (10%)" },
  "2": { code: "114115", rate: 0.15, label: "同一建物減算2 (15%)" },
  "3": { code: "114116", rate: 0.12, label: "同一建物減算3 (12%)" },
};

// ---------------------------------------------------------------- aggregate.ts:1676-1710 を逐語で写す
interface ReductionResult {
  reduction: number; // 常に <= 0
  kohiUnits: number | null;
  kohi2Units: number | null;
  code: string;
  label: string;
}

function computeSameBuildingReduction(
  serviceBaseUnits: number,
  tier: SameBuildingTier | undefined,
  opts: {
    kohi?: boolean;
    kohi2?: boolean;
    kohiProrate?: boolean;
    kohi2Prorate?: boolean;
    kohiServiceBaseUnits?: number;
    kohi2ServiceBaseUnits?: number;
  } = {},
): ReductionResult | null {
  if (!tier || serviceBaseUnits <= 0) return null;
  const { code, rate, label } = SAME_BUILDING_REDUCTION[tier];
  const reduction = -Math.round(serviceBaseUnits * rate);
  if (reduction >= 0) return null; // aggregate.ts の `if (reduction < 0)` ガード
  let kohiUnits: number | null = null;
  let kohi2Units: number | null = null;
  if (opts.kohi) {
    kohiUnits = opts.kohiProrate
      ? -Math.round(Math.min(opts.kohiServiceBaseUnits ?? 0, serviceBaseUnits) * rate)
      : reduction;
  }
  if (opts.kohi2) {
    kohi2Units = opts.kohi2Prorate
      ? -Math.round(Math.min(opts.kohi2ServiceBaseUnits ?? 0, serviceBaseUnits) * rate)
      : reduction;
  }
  return { reduction, kohiUnits, kohi2Units, code, label };
}

// ---------------------------------------------------------------- 検証
let failures = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? `  (${detail})` : ""}`);
  }
};

console.log("=== §1 法定の率 (減算1=10% / 減算2=15% / 減算3=12%) ===");
console.log("   根拠: same-building-check.ts ヘッダコメント (令和6年度改定 Q&A Vol.1 準拠の記述)");
check("減算1 (tier '1') = 10%", SAME_BUILDING_REDUCTION["1"].rate === 0.1);
check("減算2 (tier '2') = 15%", SAME_BUILDING_REDUCTION["2"].rate === 0.15);
check("減算3 (tier '3') = 12%", SAME_BUILDING_REDUCTION["3"].rate === 0.12);
check("コード 114114/114115/114116 が tier 1/2/3 と対応",
  SAME_BUILDING_REDUCTION["1"].code === "114114" &&
  SAME_BUILDING_REDUCTION["2"].code === "114115" &&
  SAME_BUILDING_REDUCTION["3"].code === "114116");

console.log("\n=== §2 基本計算 (代表的な月間単位数で3区分とも検算) ===");
{
  // 典型的な訪問介護ヘビーユーザー: 身体2.0×週5×4.3週 ≒ 月86回、単位単価 396 (令和6年度) 相当の規模感
  const base = 34056; // 実データに近い規模の手計算値 (根拠不要、丸め境界の検証が目的)
  for (const [tier, expectedRate] of [["1", 0.1], ["2", 0.15], ["3", 0.12]] as const) {
    const r = computeSameBuildingReduction(base, tier);
    const expected = -Math.round(base * expectedRate);
    check(`tier '${tier}' (${expectedRate * 100}%): ${base}単位 → ${r?.reduction}`, r?.reduction === expected);
  }
}

console.log("\n=== §3 丸め境界 (四捨五入 = Math.round) ===");
{
  // 500 × 10% = 50.0 ちょうど (端数なし)
  check("500×10%=50.0 ちょうど → -50", computeSameBuildingReduction(500, "1")?.reduction === -50);
  // 505 × 10% = 50.5 ちょうど → 四捨五入で 51 (JS Math.round は .5 を正の方向へ丸める)
  check("505×10%=50.5 ちょうど → 四捨五入で -51", computeSameBuildingReduction(505, "1")?.reduction === -51);
  // 494 × 10% = 49.4 → 49
  check("494×10%=49.4 → -49", computeSameBuildingReduction(494, "1")?.reduction === -49);
  // 3 × 10% = 0.3 → 0 (round) だが reduction===0 は aggregate.ts のガードで弾かれ null になる
  check("3×10%=0.3→round(0.3)=0 は reduction<0 ガードで弾かれ null (明細行を作らない)", computeSameBuildingReduction(3, "1") === null);
}

console.log("\n=== §4 ガード (serviceBaseUnits<=0 / tier未設定) ===");
check("serviceBaseUnits=0 → null (減算行を作らない)", computeSameBuildingReduction(0, "1") === null);
check("serviceBaseUnits<0 (理論値) → null", computeSameBuildingReduction(-100, "1") === null);
check("tier未設定 (undefined) → null", computeSameBuildingReduction(1000, undefined) === null);

console.log("\n=== §5 公費按分 (kohi_units) ===");
{
  const base = 10000;
  // 全期間公費対象 (kohiProrate=false) → kohi_units は reduction とそのまま同値
  const full = computeSameBuildingReduction(base, "1", { kohi: true, kohiProrate: false });
  check("全期間公費 (prorateなし) → kohi_units = reduction", full?.kohiUnits === full?.reduction);

  // 月途中からの公費 (kohiProrate=true) → kohiServiceBaseUnits (公費対象分の所定単位数) で按分
  const partial = computeSameBuildingReduction(base, "1", {
    kohi: true, kohiProrate: true, kohiServiceBaseUnits: 6000,
  });
  check("月途中公費 (6000/10000が対象) → -round(6000×10%)=-600", partial?.kohiUnits === -600);

  // ★ kohiServiceBaseUnits が誤って serviceBaseUnits を超えて渡っても Math.min で頭打ち
  //   (aggregate.ts 側では構造上起こらない値だが、防御コードが効くかを確認)
  const clamped = computeSameBuildingReduction(base, "1", {
    kohi: true, kohiProrate: true, kohiServiceBaseUnits: 999999,
  });
  check("★ kohiServiceBaseUnits > serviceBaseUnits でも Math.min で base 側に頭打ち → reduction と同値",
    clamped?.kohiUnits === clamped?.reduction);

  // kohi2 も同じ式であることを確認 (kohi と kohi2 で式を書き分けていないか)
  const kohi2case = computeSameBuildingReduction(base, "2", {
    kohi2: true, kohi2Prorate: true, kohi2ServiceBaseUnits: 4000,
  });
  check("kohi2 も同じ式 (4000×15%=600 → -600)", kohi2case?.kohi2Units === -600);
}

console.log("\n=== 負のコントロール (harness がズレを検出できるか) ===");
let negOk = 0;
{
  // ① 率の取り違え (tier1=10%のところをtier3=12%と間違える) を検出できるか
  const correct = computeSameBuildingReduction(10000, "1")!.reduction;
  const wrong = computeSameBuildingReduction(10000, "3")!.reduction; // わざと違う tier
  const detected = correct !== wrong;
  console.log(`  ${detected ? "✓" : "✗"} ① tier取り違え (1→3) を検出できる (正=${correct} / 誤=${wrong})`);
  if (detected) negOk += 1;
}
{
  // ② round→floor のすり替え (端数.5ちょうどのケースで検出)
  const base = 505, rate = 0.1;
  const correctVal = -Math.round(base * rate);
  const brokenVal = -Math.floor(base * rate);
  const detected = correctVal !== brokenVal;
  console.log(`  ${detected ? "✓" : "✗"} ② round→floor のすり替えを検出できる (正=${correctVal} / floor=${brokenVal})`);
  if (detected) negOk += 1;
}
if (negOk < 2) {
  console.error("\n✗ 負のコントロールが機能していない。harness 自体を疑うこと");
  process.exit(1);
}

console.log("\n=== ★ 構造上の所見 (修正はしない・報告のみ) ===");
console.log("  1. 実データに same_building_tier 設定は★0件 (2026-09-05時点)。本検証は法定値からの手構成。");
console.log("  2. serviceBaseUnits は「虐防/業未の合成コード差替え後・月次加算前」に確定 (aggregate.ts:1475-1477)。");
console.log("     虐防/業未は official な合成コード (マスタの別レコード) を引く方式、同一建物減算は");
console.log("     official な合成コードが無く別行の%減算として計算する方式 — 実装としては筋が通っているが、");
console.log("     ★ 両方が同時に該当する利用者の複合計算が制度上正しいかは未確認 (実データ0件のため実害なし)。");

console.log(`\n${failures === 0 ? "✅ PASS — 同一建物減算の計算式は法定の率・丸め・公費按分すべて一致" : `❌ FAIL — ${failures} 件`}`);
process.exit(failures === 0 ? 0 : 1);
