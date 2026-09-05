/**
 * 特定事業所集中減算 (居宅介護支援) の ★ 純関数部分の検証 (DB 不使用)
 *
 *   npx tsx scripts/shuchu-gensan-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   src/lib/shuchu-gensan.ts に検証 script が無いまま (2026-09-05 時点)。
 *   判定期間の月境界・対象サービスの文字列マッチ順序・80%境界の集計は
 *   どれも「一見単純だが境界を間違えると事故る」型なので先に固定する。
 *
 *   規則 (ファイル冒頭コメントより):
 *     判定期間 前期 3/1〜8/31 (10月〜翌3月に適用) / 後期 9/1〜翌2月末 (4月〜9月に適用)
 *     対象サービス 訪問介護 / 通所介護 / 地域密着型通所介護 / 福祉用具貸与
 *     「地域密着型通所介護」を先に判定して「通所介護」と区別する
 *     「認知症対応型通所介護」は対象外
 *     法人の紹介率 (利用者×事業所のユニーク件数の構成比) が 80% 超で減算対象
 */
import {
  currentShuchuPeriod,
  shuchuPeriodMonths,
  shuchuPeriodInfo,
  matchTargetService,
  normalizeProviderName,
  extractFromServiceUsage,
  extractFromCarePlan2,
  aggregateConcentration,
  type PlacementPair,
  type CorpResolver,
} from "@/lib/shuchu-gensan";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

// ── currentShuchuPeriod の月境界 ────────────────────────────────────────
eq("3月1日 → 前期 (境界の最初の日)", currentShuchuPeriod(new Date(2026, 2, 1)), { year: 2026, half: "zenki" });
eq("8月31日 → 前期 (境界の最後の日)", currentShuchuPeriod(new Date(2026, 7, 31)), { year: 2026, half: "zenki" });
eq("★ 9月1日 → 後期 (前期から切り替わる日)", currentShuchuPeriod(new Date(2026, 8, 1)), { year: 2026, half: "kouki" });
eq("2月28日 → 後期 (前年扱い)", currentShuchuPeriod(new Date(2027, 1, 28)), { year: 2026, half: "kouki" });
eq("★ 1月1日 → 前年の後期 (年をまたぐ)", currentShuchuPeriod(new Date(2027, 0, 1)), { year: 2026, half: "kouki" });
eq("12月31日 → 当年の後期", currentShuchuPeriod(new Date(2026, 11, 31)), { year: 2026, half: "kouki" });

// ── shuchuPeriodMonths ──────────────────────────────────────────────────
eq("前期の月一覧", shuchuPeriodMonths({ year: 2026, half: "zenki" }), ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]);
eq("★ 後期の月一覧 (年をまたぐ)", shuchuPeriodMonths({ year: 2026, half: "kouki" }), ["2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02"]);

// ── shuchuPeriodInfo ────────────────────────────────────────────────────
{
  const zenki = shuchuPeriodInfo({ year: 2026, half: "zenki" });
  eq("前期の日付範囲", [zenki.start, zenki.endExclusive], ["2026-03-01", "2026-09-01"]);
  eq("前期の適用期間ラベル", zenki.applyLabel, "2026年10月〜2027年3月");
  const kouki = shuchuPeriodInfo({ year: 2026, half: "kouki" });
  eq("★ 後期の日付範囲 (年をまたぐ endExclusive)", [kouki.start, kouki.endExclusive], ["2026-09-01", "2027-03-01"]);
  eq("後期の適用期間ラベル", kouki.applyLabel, "2027年4月〜9月");
}

// ── matchTargetService: 判定順序と除外 ──────────────────────────────────
eq("★ 地域密着型通所介護 を 通所介護 より先に判定", matchTargetService("地域密着型通所介護"), "地域密着型通所介護");
eq("★ 認知症対応型通所介護 は対象外 (通所介護に化けない)", matchTargetService("認知症対応型通所介護"), null);
eq("通所介護 (地域密着型を含まない)", matchTargetService("通所介護"), "通所介護");
eq("訪問介護", matchTargetService("訪問介護"), "訪問介護");
eq("福祉用具貸与", matchTargetService("福祉用具貸与"), "福祉用具貸与");
eq("対象外サービス (訪問看護等) は null", matchTargetService("訪問看護"), null);
eq("空文字は null", matchTargetService(""), null);
eq("★ category が優先される (テキストと矛盾しても category を採る)", matchTargetService("何か別の文字列", "11"), "訪問介護");
eq("category が未知のコードなら text 側にフォールバック", matchTargetService("福祉用具貸与", "99"), "福祉用具貸与");
eq("category が地域密着(78)ならテキストより優先", matchTargetService("通所介護", "78"), "地域密着型通所介護");

// ── normalizeProviderName ───────────────────────────────────────────────
eq("半角スペース除去", normalizeProviderName("株式会社 テスト 事業所"), "株式会社テスト事業所");
eq("★ 全角スペース (\\s に含まれる) も除去", normalizeProviderName("株式会社　テスト　事業所"), "株式会社テスト事業所");
eq("スペース無しはそのまま", normalizeProviderName("テスト事業所"), "テスト事業所");

// ── extractFromServiceUsage ─────────────────────────────────────────────
{
  const rows = [
    { user_id: "u1", services: [{ content: "訪問介護", provider: "A社" }, { content: "通所介護", provider: "B社" }] },
    { user_id: "u2", services: [{ content: "訪問看護", provider: "C社" }] }, // 対象外サービスのみ
    { user_id: "u3", services: [{ content: "訪問介護", provider: "" }] }, // provider 空
    { user_id: "u4", services: "not-an-array" }, // 不正な形
    { user_id: "u5", services: [] }, // 空配列 (docsWithRows に数えない)
  ];
  const { pairs, docsWithRows } = extractFromServiceUsage(rows as never);
  eq("provider空・対象外サービス・不正形式・空配列は除外される", pairs.length, 2);
  eq("抽出されたpairsの中身", pairs, [
    { userId: "u1", service: "訪問介護", provider: "A社" },
    { userId: "u1", service: "通所介護", provider: "B社" },
  ]);
  eq("★ docsWithRows は「サービス行が1行以上ある文書数」(対象外サービスのみでも数える)", docsWithRows, 3);
}

// ── extractFromCarePlan2 (新形式 blocks / 旧形式 needs_blocks) ──────────
{
  const rows = [
    { user_id: "u1", blocks: [{ goals: [{ services: [{ type: "1", content: "訪問介護", provider: "A社" }] }] }], needs_blocks: null },
    { user_id: "u2", blocks: null, needs_blocks: [{ goals: [{ services: [{ type: "2", content: "通所介護", provider: "B社" }] }] }] },
  ];
  const { pairs, docsWithRows } = extractFromCarePlan2(rows as never);
  eq("新形式(blocks)からも抽出できる", pairs.some((p) => p.userId === "u1" && p.provider === "A社"), true);
  eq("★ 旧形式(needs_blocks)からも抽出できる (blocksが無くてもfallback)", pairs.some((p) => p.userId === "u2" && p.provider === "B社"), true);
  eq("2文書とも数える", docsWithRows, 2);
}

// ── aggregateConcentration: 80%境界と重複排除 ───────────────────────────
{
  // 同一利用者×同一事業所が複数回出ても1件 (ユニーク化)
  const resolve: CorpResolver = (provider) => ({ corp: provider, unregistered: false });
  const dupPairs: PlacementPair[] = [
    { userId: "u1", service: "訪問介護", provider: "A社" },
    { userId: "u1", service: "訪問介護", provider: "A社" }, // 重複 (同一利用者・同一事業所)
    { userId: "u2", service: "訪問介護", provider: "A社" },
  ];
  const { services } = aggregateConcentration(dupPairs, resolve);
  const houmon = services.find((s) => s.service === "訪問介護")!;
  eq("★ 同一利用者×同一事業所の重複はユニーク化される (3件→2件)", houmon.total, 2);

  // 80%ちょうど / 超える / 下回る の3点
  const mk = (n: number, id: string, provider: string): PlacementPair[] =>
    Array.from({ length: n }, (_, i) => ({ userId: `${id}${i}`, service: "訪問介護" as const, provider }));

  // 79/100 = 80%未満
  const under = aggregateConcentration([...mk(79, "u", "A社"), ...mk(21, "y", "B社")], resolve);
  const underRow = under.services.find((s) => s.service === "訪問介護")!;
  eq("★ 79% (未満側) は超過判定基準を満たさない", underRow.topShare > 80, false);

  // 80/100 = ちょうど80%
  const exact = aggregateConcentration([...mk(80, "u", "A社"), ...mk(20, "y", "B社")], resolve);
  const exactRow = exact.services.find((s) => s.service === "訪問介護")!;
  eq("★ ちょうど80% (超過ではなく境界値) が正しく算出される", exactRow.topShare, 80);
  eq("★ 80%ちょうどは「超過」の判定基準 (>80) では対象にならないことを確認できる形で返る", exactRow.topShare > 80, false);

  // 81/100 = 80%超
  const over = aggregateConcentration([...mk(81, "u", "A社"), ...mk(19, "z", "B社")], resolve);
  const overRow = over.services.find((s) => s.service === "訪問介護")!;
  eq("★ 81% (超過側) は超過判定基準を満たす", overRow.topShare > 80, true);
}

// ── unregistered フラグ ──────────────────────────────────────────────────
{
  const resolve: CorpResolver = (provider) =>
    provider === "不明な事業所" ? { corp: `(マスタ未登録) ${provider}`, unregistered: true } : { corp: provider, unregistered: false };
  const pairs: PlacementPair[] = [{ userId: "u1", service: "訪問介護", provider: "不明な事業所" }];
  const { hasUnregistered } = aggregateConcentration(pairs, resolve);
  eq("★ マスタ未登録の事業所があると hasUnregistered=true になる", hasUnregistered, true);
}

// ── 対象4サービス以外の総数が0でも4サービス全部が結果に含まれる ─────────
{
  const resolve: CorpResolver = (p) => ({ corp: p, unregistered: false });
  const { services } = aggregateConcentration([], resolve);
  eq("★ pairsが空でも SHUCHU_TARGET_SERVICES の4種すべてが結果に出る (0件として)", services.length, 4);
  eq("0件のサービスは topShare=0 / topCorp=null", [services[0].total, services[0].topShare, services[0].topCorp], [0, 0, null]);
}

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① 判定順序を逆にする (通所介護を先に判定する壊れた実装) を模擬
  const brokenOrder = (text: string): string | null => {
    if (text.includes("通所介護")) return "通所介護"; // ★ 地域密着型を先に見ない壊れた版
    if (text.includes("地域密着型通所介護")) return "地域密着型通所介護";
    return null;
  };
  const correct = matchTargetService("地域密着型通所介護");
  const broken = brokenOrder("地域密着型通所介護");
  const detected1 = correct !== broken;
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: 判定順序の違いを検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ 判定順序を逆にするバグを検出できる (正=${correct} / 壊れた版=${broken})`);

  // ② 重複排除をしない壊れた集計 (Set を使わず配列長をそのまま数える) との差
  const resolve: CorpResolver = (p) => ({ corp: p, unregistered: false });
  const dup: PlacementPair[] = [
    { userId: "u1", service: "訪問介護", provider: "A社" },
    { userId: "u1", service: "訪問介護", provider: "A社" },
  ];
  const correctTotal = aggregateConcentration(dup, resolve).services.find((s) => s.service === "訪問介護")!.total;
  const brokenTotal = dup.length; // 重複排除しない素朴な実装
  const detected2 = correctTotal !== brokenTotal;
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: 重複排除の有無を検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ 重複排除しないバグを検出できる (正=${correctTotal} / 壊れた版=${brokenTotal})`);
}

console.log(`\n特定事業所集中減算 (純関数部分) の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
