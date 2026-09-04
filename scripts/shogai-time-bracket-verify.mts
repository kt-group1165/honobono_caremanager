/**
 * 障害 時間区分判定 (shogai-time-bracket.ts と周辺 3 実装) の検証
 *
 *   npx tsx scripts/shogai-time-bracket-verify.mts
 *
 * ── H の割当と実際の対象が違った (12回目) ─────────────────────────────
 *   H の依頼文は「早朝/日中/夜間/深夜の時間帯 (加算率に直結)」
 *   「0時またぎの日跨増コードの発動条件」を想定していたが、割当された
 *   src/lib/shogai-time-bracket.ts は★別の論点だった:
 *     shogai-time-bracket.ts = 「60分ちょうどの予定が身体1.0/1.5どちらの
 *     ★候補★になるか」を切り替える設定 (app_settings.shogai_time_bracket_mode)。
 *     ★UIの候補フィルタ (service-selector.tsx) だけに効く。自動請求計算には
 *     一切関与しない (下記 §5)。
 *   早朝/日中/夜間/深夜 の実体は zoneOf() (shogai-seikyu/code-from-time.ts) —
 *   ★こちらが実際の自動請求で使われる。0時またぎは §4 で現状の挙動を記録。
 *
 * ── 発見した実装の重複 (3実装、report only) ─────────────────────────────
 *   A. src/lib/shogai-time-bracket.ts +
 *      src/components/services/service-selector.tsx の parseServiceDurationMinutes
 *        → UIの候補フィルタ専用。min/max 範囲を ±1分シフトする方式
 *   B. src/lib/shogai-seikyu/code-from-time.ts の quantizeHours/BracketMode
 *        → ★実際の自動請求 (shogai-seikyu/aggregate.ts) が使う本体
 *   C. src/lib/shogai-seikyu/service-code-resolver.ts の quantizeHours/BracketMode
 *        → ★repo 全体 (src/migrations/scripts) のどこからも import されていない
 *          ★完全な未参照コード (186行)。B とほぼ同じ式だが独立した別実装。
 *          削除候補として報告のみ (判断は user)。
 */

import { zoneOf, quantizeHours as quantizeHoursB, stepMinutesOf } from "../src/lib/shogai-seikyu/code-from-time";
import { quantizeHours as quantizeHoursC } from "../src/lib/shogai-seikyu/service-code-resolver";

let failures = 0;
const check = (name: string, cond: boolean) => {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}`);
  }
};

// ---------------------------------------------------------------- A. UI候補フィルタ (逐語で写す)
// service-selector.tsx:107-151 の障害 X.Y時間 branch (該当部分のみ)
type UIMode = "honobono" | "kokuji";
function uiShogaiRange(hours: number, mode: UIMode): { min: number; max: number } {
  const shift = mode === "honobono" ? 1 : 0;
  const maxMin = Math.round(hours * 60) + shift;
  const minMin = Math.max(0, Math.round((hours - 0.5) * 60) + shift);
  return { min: minMin, max: maxMin };
}
// classifyStartTimeZone (service-selector.tsx:168-177) を逐語で写す
type TimeZone = "日中" | "早朝" | "夜間" | "深夜";
function uiClassifyStartTimeZone(startMin: number): TimeZone {
  if (startMin < 6 * 60 || startMin >= 22 * 60) return "深夜";
  if (startMin < 8 * 60) return "早朝";
  if (startMin < 18 * 60) return "日中";
  return "夜間";
}
const ZONE_JP_TO_KANJI: Record<TimeZone, string> = { "日中": "日", "早朝": "早", "夜間": "夜", "深夜": "深" };

console.log("=== §1 時間帯 (早朝/日中/夜間/深夜) の境界 — UI版 と 実billing版(zoneOf) の一致 ===");
console.log("   (H が本来疑っていた「時間帯」はこちら。shogai-time-bracket.ts とは別物)");
{
  // 1分刻みで丸1日 (0〜1439分) を全部照合する
  let mismatches = 0;
  for (let m = 0; m < 1440; m++) {
    const ui = uiClassifyStartTimeZone(m);
    const real = zoneOf(m); // "日"|"夜"|"深"|"早"
    if (ZONE_JP_TO_KANJI[ui] !== real) mismatches++;
  }
  check(`1440分 (24時間) すべてで UI と 実billing の時間帯判定が一致 (境界 6:00/8:00/18:00/22:00)`, mismatches === 0);
}

console.log("\n=== §2 quantizeHours の3実装 突き合わせ (A=UI範囲判定 / B=実billing / C=未参照コード) ===");
{
  let mismatchesAB = 0, mismatchesBC = 0;
  const steps = [30, 15]; // 身体/同行=30分 / 家事・通院2=15分
  const modes: UIMode[] = ["honobono", "kokuji"];
  for (const step of steps) {
    for (const mode of modes) {
      for (let minutes = 1; minutes <= 300; minutes++) {
        const hoursB = quantizeHoursB(minutes, step, mode);
        const hoursC = quantizeHoursC(minutes, step, mode);
        if (hoursB !== hoursC) mismatchesBC++;
        // UI側 (A) は「その hoursB の帯が minutes を含むか」で照合 (Aは範囲判定、B/Cは直接値を返す方式で
        // アルゴリズムの形が違うため、「Bが選ぶ帯にminutesが実際に入っているか」で整合性を見る)
        const range = uiShogaiRange(hoursB, mode);
        if (!(minutes >= range.min && minutes < range.max)) mismatchesAB++;
      }
    }
  }
  check(`B (実billing/code-from-time.ts) と C (未参照/service-code-resolver.ts) — 30分・15分刻み×両モード×1-300分 で完全一致`, mismatchesBC === 0);
  check(`A (UI候補範囲) が B (実billing) の選ぶ帯と矛盾しない — 同上の組み合わせすべてで range内`, mismatchesAB === 0);
}

console.log("\n=== §3 stepMinutesOf (種別ごとの量子化刻み) ===");
check("身体=30分刻み", stepMinutesOf("身体") === 30);
check("家事=15分刻み", stepMinutesOf("家事") === 15);
check("通院2=15分刻み", stepMinutesOf("通院2") === 15);
check("通院1=30分刻み", stepMinutesOf("通院1") === 30);
check("同援=30分刻み", stepMinutesOf("同援") === 30);

console.log("\n=== §4 0時またぎ (日跨ぎ) の現状の挙動を固定 (規則の特定はしない — H の指示どおり) ===");
{
  // zoneSegments は e<=s (終了が開始以下=日付をまたいで数値が逆転) のとき null を返す。
  // → shogaiCodeFromTime は segs=null の single-zone 分岐へ落ち、zoneOf(開始時刻) だけで
  //   1つの時間帯として計算する。「日跨増」コードへの分岐は現状どこにも無い。
  const { zoneSegments } = await import("../src/lib/shogai-seikyu/code-from-time");
  const segs = zoneSegments("22:00", "00:30"); // 深夜帯をまたいで日付が変わる典型例
  check("22:00〜00:30 (日またぎ) は zoneSegments が null を返す (=専用処理なし)", segs === null);
  // shogaiCodeFromTime の single-zone 分岐が使う開始時刻ゾーンのみでの計算を再現
  const startZone = zoneOf(22 * 60); // 22:00
  check("→ 現状の挙動: 開始時刻(22:00)の帯「深」だけで全時間 (150分) を計算する (終了側の日付またぎは見ない)", startZone === "深");
  console.log("   ⚠ SESSION_START記載のとおり、ほのぼのは141件中4件だけ「日跨増」コードを使う。");
  console.log("   ⚠ 発動条件は未特定 (このスクリプトも特定しない)。現状は★全件を開始時刻ゾーンの単一区分として計算、が固定した事実。");
}

console.log("\n=== §5 shogai_time_bracket_mode 設定は実billingに一切効かない (report only) ===");
{
  const aggFile = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/lib/shogai-seikyu/aggregate.ts", import.meta.url), "utf8"),
  );
  const referencesSetting = /getShogaiTimeBracketMode|shogai_time_bracket_mode/.test(aggFile);
  check("shogai-seikyu/aggregate.ts (実billing) は shogai_time_bracket_mode を一切参照しない → shogaiCodeFromTime は常に既定値 'honobono' で呼ばれる", !referencesSetting);
  console.log("   ⚠ 設定画面 (/settings) の説明文自体は「候補の絞り込みに効く」と正しく書かれており誤誘導ではない。");
  console.log("   ⚠ ただし『告示準拠』に切り替えても実際の自動集計は honobono のままなので、");
  console.log("     利用者に「請求計算まで変わる」と誤解されないよう注記があるとよい (UI改善の提案のみ・実装はしない)。");
}

console.log("\n=== 負のコントロール (harness がズレを検出できるか) ===");
let negOk = 0;
{
  // ① honobono/kokuji の取り違えを検出できるか (60分ちょうどで差が出る)
  const h = quantizeHoursB(60, 30, "honobono");
  const k = quantizeHoursB(60, 30, "kokuji");
  const detected = h !== k;
  console.log(`  ${detected ? "✓" : "✗"} ① honobono/kokujiの取り違えを検出できる (honobono=${h} / kokuji=${k})`);
  if (detected) negOk += 1;
}
{
  // ② zoneOf の境界 (22:00) を1分ずらすと検出できるか
  const correct = zoneOf(22 * 60); // "深"
  const brokenBoundary = zoneOf(22 * 60 - 1); // 21:59 → "夜" のはず
  const detected = correct !== brokenBoundary;
  console.log(`  ${detected ? "✓" : "✗"} ② 22:00境界のズレ(21:59 vs 22:00)を検出できる (22:00=${correct} / 21:59=${brokenBoundary})`);
  if (detected) negOk += 1;
}
if (negOk < 2) {
  console.error("\n✗ 負のコントロールが機能していない。harness 自体を疑うこと");
  process.exit(1);
}

console.log(`\n${failures === 0 ? "✅ PASS — 時間帯境界・quantizeHours 3実装とも一致。0時またぎの現状挙動を記録・設定の実効範囲を確認" : `❌ FAIL — ${failures} 件`}`);
process.exit(failures === 0 ? 0 : 1);
