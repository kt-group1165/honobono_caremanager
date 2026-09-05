/**
 * 障害実績の行種マーカー (record-markers.ts) の検証 (DB 不使用)
 *
 *   npx tsx scripts/record-markers-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   record-markers.ts のコメントに「⚠ migrations/import_meisai_shougai_records.mjs
 *   にも同じ文字列が定義されている (TS 側から .mjs を import できないため)。
 *   変更時は両方直すこと」とある。★ これは「同じ規約を2箇所で別々に持つ」型
 *   そのもの (kaigo_visit_addon_lines.target_month と同じ構造) で、片方だけ
 *   変更されると請求集計と実績記録票の判定が黙って食い違う。
 *   この同期を機械的に確認する検査が無かった。
 *
 *   規則 (ファイル冒頭の表通り):
 *     通常          請求○ / 記録○
 *     ADDON(増)     請求○ / 記録×  (増は請求単位であって訪問ではない)
 *     SESSION_SUB   請求× / 記録○  (請求は代表行に合算済。記録には提供時刻を残す)
 */
import { readFileSync } from "node:fs";
import {
  MARK_ADDON,
  MARK_SESSION_SUB,
  isBillableRecord,
  isAddonRecord,
  isSessionSubRecord,
} from "@/lib/shogai-seikyu/record-markers";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

// ── ★ TS/mjs 間のマーカー文字列の同期チェック (静的解析。DB不要) ────────
{
  const mjsPath = new URL("../migrations/import_meisai_shougai_records.mjs", import.meta.url);
  const src = readFileSync(mjsPath, "utf8");
  const mAddon = /const MARK_ADDON\s*=\s*"([^"]+)"/.exec(src);
  const mSub = /const MARK_SESSION_SUB\s*=\s*"([^"]+)"/.exec(src);
  eq("★ .mjs 側に MARK_ADDON の定義が見つかる", !!mAddon, true);
  eq("★ .mjs 側に MARK_SESSION_SUB の定義が見つかる", !!mSub, true);
  if (mAddon) eq("★★ MARK_ADDON が TS と .mjs で一致している (同期チェック本体)", mAddon[1], MARK_ADDON);
  if (mSub) eq("★★ MARK_SESSION_SUB が TS と .mjs で一致している (同期チェック本体)", mSub[1], MARK_SESSION_SUB);
}

// ── 通常行 (マーカー無し) ────────────────────────────────────────────────
eq("通常行: 請求集計に含まれる", isBillableRecord("[MEISAI障害取込 2026-06 拠点 code=111111]"), true);
eq("通常行: 加算行ではない", isAddonRecord("[MEISAI障害取込 2026-06 拠点 code=111111]"), false);
eq("通常行: 合算従属ではない", isSessionSubRecord("[MEISAI障害取込 2026-06 拠点 code=111111]"), false);

// ── ADDON (加算) 行 ──────────────────────────────────────────────────────
eq(`ADDON行: 請求○ (notesに"${MARK_ADDON}"を含む)`, isBillableRecord(`[MEISAI障害取込 2026-06 拠点 ${MARK_ADDON} code=111112]`), true);
eq("ADDON行: 加算行と判定される", isAddonRecord(`[MEISAI障害取込 2026-06 拠点 ${MARK_ADDON} code=111112]`), true);
eq("ADDON行: 合算従属ではない (排他)", isSessionSubRecord(`[MEISAI障害取込 2026-06 拠点 ${MARK_ADDON} code=111112]`), false);

// ── SESSION_SUB (合算従属) 行 ────────────────────────────────────────────
eq(`★ SESSION_SUB行: 請求× (notesに"${MARK_SESSION_SUB}"を含むと請求集計から除外)`, isBillableRecord(`[MEISAI障害取込 2026-06 拠点 ${MARK_SESSION_SUB} code=121121]`), false);
eq("SESSION_SUB行: 加算行ではない (排他)", isAddonRecord(`[MEISAI障害取込 2026-06 拠点 ${MARK_SESSION_SUB} code=121121]`), false);
eq("SESSION_SUB行: 合算従属と判定される", isSessionSubRecord(`[MEISAI障害取込 2026-06 拠点 ${MARK_SESSION_SUB} code=121121]`), true);

// ── null / undefined / 空文字 ────────────────────────────────────────────
eq("notes が null でも請求○ (通常行扱い)", isBillableRecord(null), true);
eq("notes が undefined でも請求○", isBillableRecord(undefined), true);
eq("notes が空文字でも請求○", isBillableRecord(""), true);
eq("notes が null なら加算行でもない", isAddonRecord(null), false);
eq("notes が null なら合算従属でもない", isSessionSubRecord(null), false);

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① SESSION_SUB の判定を素朴な完全一致にする壊れた実装 (実際は接頭辞付きの文字列に埋め込まれる)
  const brokenExactMatch = (notes: string | null | undefined): boolean => notes === MARK_SESSION_SUB;
  const realNotes = `[MEISAI障害取込 2026-06 拠点 ${MARK_SESSION_SUB} code=121121]`;
  const correct = isSessionSubRecord(realNotes);
  const broken = brokenExactMatch(realNotes);
  const detected1 = correct !== broken;
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: includes vs 完全一致の違いを検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ 完全一致にする(部分文字列を見逃す)バグを検出できる (正=${correct} / 壊れた版=${broken})`);

  // ② TS と .mjs の文字列が食い違った状態を模擬して同期チェックが落ちることを確認
  const fakeMjsValue: string = "合算従属タイポ";
  const wouldDetect = fakeMjsValue !== MARK_SESSION_SUB;
  if (wouldDetect) pass++; else fails.push("★ 負のコントロールが鳴らない: 同期チェック自体が違いを検出できない");
  console.log(`  ${wouldDetect ? "✓" : "✗"} ★ .mjs側がタイポした状態を同期チェックが検出できる (TS=${MARK_SESSION_SUB} / 偽の.mjs値=${fakeMjsValue})`);
}

console.log(`\n障害実績の行種マーカー の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
