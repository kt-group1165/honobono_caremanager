/**
 * kaigo_monitoring_items の行数決定・保存payload組み立ての検証 (DB 不使用)
 *
 *   npx tsx scripts/monitoring-rows-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   2026-09-14発見: 画面がFIXED_ROWS=6固定で、7件目以降を読み込み時に
 *   落とし、保存時にも6行に切り詰めて既存の7件目以降を消していた
 *   (実データで浅野修司=7件・秋葉法昌=8件を確認)。
 *   src/lib/monitoring-rows.ts に切り出した rowCountFor / buildSavePayload
 *   の境界を検証する。
 */
import { rowCountFor, isEmptyMonitoringItem, buildSavePayload, type MonitoringItemFields } from "../src/lib/monitoring-rows";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

const empty = (n: number): MonitoringItemFields => ({
  item_number: n, short_term_goal: "", goal_period_start: "", goal_period_end: "",
  service_type: "", provider_name: "", implementation_status: "", user_satisfaction: "",
  family_satisfaction: "", satisfaction_comment: "", achievement: "", adl_change: "",
  plan_revision_needed: "", revision_reason: "",
});
const filled = (n: number, goal = "目標"): MonitoringItemFields => ({ ...empty(n), short_term_goal: goal });

// ── rowCountFor ────────────────────────────────────────────────────────────
eq("空配列 → 最低行数(6)", rowCountFor([], 6), 6);
eq("item_numberの最大が6未満 → 最低行数(6)のまま", rowCountFor([{ item_number: 3 }], 6), 6);
eq("★ item_numberの最大が6を超える(浅野修司=7件相当) → 7", rowCountFor([{ item_number: 7 }], 6), 7);
eq("★ item_numberの最大が6を超える(秋葉法昌=8件相当) → 8", rowCountFor([{ item_number: 8 }, { item_number: 3 }], 6), 8);

// ── isEmptyMonitoringItem ───────────────────────────────────────────────────
eq("全項目空 → true", isEmptyMonitoringItem(empty(1)), true);
eq("短期目標だけ入っている → false", isEmptyMonitoringItem(filled(1)), false);
eq("plan_revision_neededだけ入っている → false", isEmptyMonitoringItem({ ...empty(1), plan_revision_needed: "あり" }), false);

// ── buildSavePayload ────────────────────────────────────────────────────────
{
  const items = [filled(1, "目標A"), empty(2), filled(3, "目標B"), empty(4), empty(5), empty(6), filled(7, "目標C")];
  const saved = buildSavePayload(items);
  eq("★ 空行を除外し、7件目も含めて保存対象になる (6件に切り詰めない)", saved.map((i) => i.item_number), [1, 3, 7]);
}
{
  // 8行 (秋葉法昌相当) を読んで保存用payloadが8行 (空行なし想定) になることを確認
  const items = Array.from({ length: 8 }, (_, i) => filled(i + 1, `目標${i + 1}`));
  const saved = buildSavePayload(items);
  eq("8行すべて有効なら保存payloadも8行", saved.length, 8);
}

// ── 負のコントロール: 旧実装 (FIXED_ROWS=6 に切り詰める) だと壊れることを確認 ──
{
  const items = [filled(1), filled(2), filled(3), filled(4), filled(5), filled(6), filled(7), filled(8)];
  const brokenOldImpl = (source: MonitoringItemFields[]) => {
    const FIXED_ROWS = 6;
    const rows: MonitoringItemFields[] = [];
    for (let i = 1; i <= FIXED_ROWS; i++) rows.push(source.find((it) => it.item_number === i) ?? empty(i));
    return rows; // 旧実装はここで7・8件目が失われる
  };
  const broken = brokenOldImpl(items);
  const fixed = buildSavePayload(items);
  const detected = broken.length === 6 && fixed.length === 8;
  if (detected) pass++; else fails.push("★ 負のコントロールが鳴らない: FIXED_ROWS=6への切り詰めを検出できない");
  console.log(`  ${detected ? "✓" : "✗"} ★ 旧実装(6行に切り詰め)は7・8件目を失うが、新実装は8件とも保存されることを確認できる`);
}

console.log(`\nモニタリング行数・保存payloadの検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
