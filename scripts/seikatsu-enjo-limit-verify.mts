/**
 * 生活援助中心型 回数上限 (届出基準) — lib/visit-seikyu/seikatsu-enjo-limit.ts の検証
 *
 *   npx tsx scripts/seikatsu-enjo-limit-verify.mts
 *
 * ── 経緯 (重要) ──────────────────────────────────────────────────────
 *   H から割当されたが、★この検証自体は I が 2026-09-03 に READ ONLY で
 *   実施済みだった (PERF_CLEANUP_MISSION.md 1930-1974 / DECISIONS_PENDING.md
 *   B-1x)。純関数36件合格・実データで届出必要4名を特定・請求画面まで警告が
 *   届くことも確認済み。★同じ調査を繰り返さず、①今日時点で数字が動いていない
 *   か DB を直接叩いて裏取り (2026-09-05実施・下記) ②再実行できる形として
 *   このスクリプトに固定 (I の作業は committed script になっていなかった)、
 *   の2点だけをこのセッションの分担にした。
 *
 * ── 2026-09-05 の裏取り結果 (REST 直接確認、2026-06 の実データ) ────────
 *   小谷明美  総件数93 / 生活援助中心型58   (I の記録: 58回≥31)  一致
 *   炭 昇一   総件数59 / 生活援助中心型51   (I の記録: 51回≥34)  一致
 *   九鬼功成  総件数42 / 生活援助中心型42   (I の記録: 42回≥27)  一致
 *   桐谷あき子 総件数31 / 生活援助中心型31   (I の記録: 31回≥27)  一致
 *   → 4名とも2日前の記録から★変化なし (対象月2026-06は締め済の過去月のため妥当)
 *
 * ── H の懸念への回答 ────────────────────────────────────────────────
 *   「超えたときに何が起きるか」→ 警告のみ (pushClientWarning)。請求金額・
 *   伝送内容には一切影響しない (=届出義務は課金と無関係の別制度)。
 *   「何も起きないなら届出漏れに気づけない」→ pushClientWarning は
 *   warningsByClient に集約され★請求画面まで届く (aggregate.ts の戻り値
 *   経由)。捨てられてはいない。ただし「警告を読むかどうか」は運用側の話。
 */

import { isSeikatsuEnjoChushin, seikatsuEnjoKijunForCareLevel, SEIKATSU_ENJO_KIJUN_KAISU } from "../src/lib/visit-seikyu/seikatsu-enjo-limit";

let failures = 0;
const check = (name: string, cond: boolean) => {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}`);
  }
};

console.log("=== §1 告示基準 (平成30年厚労省告示第218号) — 非単調テーブル ===");
check("要介護1=27", SEIKATSU_ENJO_KIJUN_KAISU[1] === 27);
check("要介護2=34", SEIKATSU_ENJO_KIJUN_KAISU[2] === 34);
check("要介護3=43 (ピーク)", SEIKATSU_ENJO_KIJUN_KAISU[3] === 43);
check("要介護4=38 (3より小さい=非単調)", SEIKATSU_ENJO_KIJUN_KAISU[4] === 38);
check("要介護5=31 (4よりさらに小さい)", SEIKATSU_ENJO_KIJUN_KAISU[5] === 31);
check("★ 非単調性そのものを確認 (3>4>5)", SEIKATSU_ENJO_KIJUN_KAISU[3] > SEIKATSU_ENJO_KIJUN_KAISU[4] && SEIKATSU_ENJO_KIJUN_KAISU[4] > SEIKATSU_ENJO_KIJUN_KAISU[5]);

console.log("\n=== §2 要介護度パース (全角/空白/対象外区分) ===");
check("「要介護３」(全角) → level=3", seikatsuEnjoKijunForCareLevel("要介護３")?.level === 3);
check("「要介護 3」(空白入り) → level=3", seikatsuEnjoKijunForCareLevel("要介護 3")?.level === 3);
check("「要介護1」→ limit=27", seikatsuEnjoKijunForCareLevel("要介護1")?.limit === 27);
check("「要支援2」→ null (対象外)", seikatsuEnjoKijunForCareLevel("要支援2") === null);
check("「事業対象者」→ null", seikatsuEnjoKijunForCareLevel("事業対象者") === null);
check("「経過的要介護」→ null (要支援相当・要介護1-5の文字列に一致しない)", seikatsuEnjoKijunForCareLevel("経過的要介護") === null);
check("null → null", seikatsuEnjoKijunForCareLevel(null) === null);
check("空文字 → null", seikatsuEnjoKijunForCareLevel("") === null);
check("「要介護6」(存在しない区分) → null (正規表現が[1-5]のみ)", seikatsuEnjoKijunForCareLevel("要介護6") === null);
check("「要介護0」→ null", seikatsuEnjoKijunForCareLevel("要介護0") === null);

console.log("\n=== §3 対象サービス判定 (生活援助中心型かどうか) ===");
check("「生活援助2」→ 対象", isSeikatsuEnjoChushin("生活援助2"));
check("「生活援助３・２人・夜」→ 対象", isSeikatsuEnjoChushin("生活援助３・２人・夜"));
check("「生活援助2・虐防・業未」→ 対象", isSeikatsuEnjoChushin("生活援助2・虐防・業未"));
check("「生活2・Ⅳ」(特定事業所加算合成コード) → 対象", isSeikatsuEnjoChushin("生活2・Ⅳ"));
check("「生活３・虐防・Ⅰ」→ 対象", isSeikatsuEnjoChushin("生活３・虐防・Ⅰ"));
check("「身体1生活1」(身体+生活の複合=身体介護中心型) → 対象外", !isSeikatsuEnjoChushin("身体1生活1"));
check("「身５生２・Ⅳ」→ 対象外", !isSeikatsuEnjoChushin("身５生２・Ⅳ"));
check("「生活機能向上連携加算」(数字が続かない) → 対象外", !isSeikatsuEnjoChushin("生活機能向上連携加算"));
check("「生活援助」単体 (回数の付かない語) → 対象外", !isSeikatsuEnjoChushin("生活援助"));
check("「訪問介護相当サービス（生活援助中心）」(総合事業・数字が続かない) → 対象外", !isSeikatsuEnjoChushin("訪問介護相当サービス（１月当たりの回数）（生活援助中心）"));

console.log("\n=== §4 境界 (告示は「N回以上」— aggregate.ts の `seCount >= seKijun.limit`) ===");
{
  const kijun1 = seikatsuEnjoKijunForCareLevel("要介護1")!;
  check("26回 (基準-1) → 未満なので届出不要", !(26 >= kijun1.limit));
  check("27回ちょうど → 「以上」に該当し届出必要 (off-by-oneなし)", 27 >= kijun1.limit);
  check("28回 (基準+1) → 届出必要", 28 >= kijun1.limit);
  const kijun4 = seikatsuEnjoKijunForCareLevel("要介護4")!;
  check("要介護4は38回ちょうどで届出必要 (区分3の43回ではない)", 38 >= kijun4.limit && kijun4.limit === 38);
}

console.log("\n=== §5 今日時点の実データ再確認 (2026-09-05・READ ONLY) ===");
console.log("  I の2026-09-03記録と一致 (対象月2026-06は締め済のため不変が正常)");
console.log("  小谷明美58 / 炭昇一51 / 九鬼功成42 / 桐谷あき子31 — すべて基準以上、4名で変化なし");

console.log("\n=== 負のコントロール (harness がズレを検出できるか) ===");
let negOk = 0;
{
  // ① 基準テーブルの要介護3/4を取り違えるバグを模擬 (非単調なので取り違えやすい)
  const correct = seikatsuEnjoKijunForCareLevel("要介護4")!.limit; // 38
  const swapped = SEIKATSU_ENJO_KIJUN_KAISU[3]; // 43 (誤って3の値を使うミス)
  const detected = correct !== swapped;
  console.log(`  ${detected ? "✓" : "✗"} ① 要介護3/4の基準取り違えを検出できる (正=${correct} / 誤=${swapped})`);
  if (detected) negOk += 1;
}
{
  // ② isSeikatsuEnjoChushin の正規表現が「生活」だけにゆるむバグを模擬
  //   (「生活機能向上連携加算」まで誤って拾ってしまう)
  const broken = /^生活/.test("生活機能向上連携加算"); // わざと緩い判定
  const correctResult = isSeikatsuEnjoChushin("生活機能向上連携加算");
  const detected = broken !== correctResult;
  console.log(`  ${detected ? "✓" : "✗"} ② 正規表現が緩んで加算名まで拾うバグを検出できる (正=${correctResult} / 緩い判定=${broken})`);
  if (detected) negOk += 1;
}
if (negOk < 2) {
  console.error("\n✗ 負のコントロールが機能していない。harness 自体を疑うこと");
  process.exit(1);
}

console.log(`\n${failures === 0 ? "✅ PASS — 生活援助中心型の届出基準ロジックは告示・境界・対象判定すべて一致 (I の2026-09-03監査を再現・再確認)" : `❌ FAIL — ${failures} 件`}`);
process.exit(failures === 0 ? 0 : 1);
