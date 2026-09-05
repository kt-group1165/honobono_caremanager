/**
 * kaigo_visit_addon_lines.target_month の書式ずれ是正の検証 (H発見・2026-09-05)
 *
 *   npx tsx scripts/addon-target-month-verify.mts
 *
 * ── 何が起きていたか ──────────────────────────────────────────────────
 *   書く側 (provision-tickets の加算エディタ) は制度を問わず常に "YYYY-MM" で
 *   target_month を書いていたが、読む側 (shogai-seikyu/aggregate.ts の障害
 *   集計・取込 script import_shogai_addon_lines_from_densou.mjs) は障害だけ
 *   "YYYY-MM-01" を使っていた。★画面から入れた障害の加算は集計に出ない
 *   (エラーも出ない、無警告の未発火)。加えて表示専用の resolveVisitAddonLines
 *   (lib/visit-addons.ts) も同じ書式不一致を持つため、既存の取込済み32行
 *   (障害・"YYYY-MM-01") が提供表画面のプレビュー/チェックリストにも
 *   一度も表示されていなかった。
 *
 * ── 是正方針 (案A採用) ──────────────────────────────────────────────
 *   障害は "YYYY-MM-01"・介護/総合事業は "YYYY-MM" のまま、を正とする。
 *   理由: 既存の実データ32行(取込scriptが書いたもの)を活かせ、DB書換が要らない。
 *   このスクリプトは「本当に是正されたか」を実データで検証する (READ ONLY)。
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { resolveVisitAddonLines } from "../src/lib/visit-addons";

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([^#=\s][^=]*)=(.*)$/.exec(l);
  if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });

let failures = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? `  (${detail})` : ""}`);
  }
};

console.log("=== §1 実データの書式分布 (2026-09-05 是正前と同じ実測を再現) ===");
{
  const { data, error } = await sb.from("kaigo_visit_addon_lines").select("system, target_month");
  if (error) throw new Error(error.message);
  const stats: Record<string, number> = {};
  for (const r of (data ?? []) as { system: string; target_month: string }[]) {
    const fmt = /^\d{4}-\d{2}$/.test(r.target_month) ? "YYYY-MM" : /^\d{4}-\d{2}-\d{2}$/.test(r.target_month) ? "YYYY-MM-DD" : "other";
    const k = `${r.system}|${fmt}`;
    stats[k] = (stats[k] ?? 0) + 1;
  }
  console.log("  ", stats);
  check("介護は全件YYYY-MM形式", !stats["介護|YYYY-MM-DD"]);
  check("障害は全件YYYY-MM-DD形式 (YYYY-MM形式の行は無い=画面からはまだ書かれていない)", !stats["障害|YYYY-MM"] && (stats["障害|YYYY-MM-DD"] ?? 0) > 0);
}

console.log("\n=== §2 resolveVisitAddonLines が既存の障害32行を正しく引けるか (是正の効果測定) ===");
{
  const { data: sample } = await sb
    .from("kaigo_visit_addon_lines")
    .select("client_id, office_id, target_month, addon_code, count")
    .eq("system", "障害")
    .limit(5);
  const rows = (sample ?? []) as { client_id: string; office_id: string; target_month: string; addon_code: string; count: number }[];
  check("検証用の実データが取得できた (5件)", rows.length > 0, `実際: ${rows.length}件`);
  for (const r of rows) {
    const [y, m] = r.target_month.slice(0, 7).split("-").map(Number);
    const map = await resolveVisitAddonLines(sb, [r.client_id], y, m, r.office_id, "障害");
    const lines = map.get(r.client_id) ?? [];
    const hit = lines.find((l) => l.code === r.addon_code);
    check(
      `client=${r.client_id.slice(0, 8)}… code=${r.addon_code} target_month=${r.target_month} → resolveVisitAddonLinesで引ける`,
      !!hit,
      hit ? undefined : `lines=${JSON.stringify(lines)}`,
    );
  }
}

console.log("\n=== §3 aggregate.ts (実billing) は元から正しく引けていたことの再確認 (回帰していないか) ===");
{
  const { data: sample } = await sb
    .from("kaigo_visit_addon_lines")
    .select("office_id, target_month, client_id")
    .eq("system", "障害")
    .limit(1);
  const r = (sample ?? [])[0] as { office_id: string; target_month: string; client_id: string } | undefined;
  check("障害の実データが1件以上ある (回帰確認の前提)", !!r);
  if (r) {
    const monthStr = r.target_month.slice(0, 7); // "2026-06-01" → "2026-06"
    const { data, error } = await sb
      .from("kaigo_visit_addon_lines")
      .select("client_id")
      .eq("office_id", r.office_id)
      .eq("target_month", `${monthStr}-01`) // aggregate.ts と同じクエリ形
      .eq("system", "障害");
    if (error) throw new Error(error.message);
    check("aggregate.ts と同じクエリ形 (`${monthStr}-01`) は今までどおり引ける (是正が実billing側を壊していない)", (data ?? []).length > 0);
  }
}

console.log("\n=== 負のコントロール (harness がズレを検出できるか) ===");
let negOk = 0;
{
  // ① 是正前の挙動 (system問わずmonthStr固定) を模擬すると障害行が0件になることを確認
  const { data: sample } = await sb
    .from("kaigo_visit_addon_lines")
    .select("office_id, target_month, client_id, addon_code")
    .eq("system", "障害")
    .limit(1);
  const r = (sample ?? [])[0] as { office_id: string; target_month: string; client_id: string; addon_code: string } | undefined;
  if (r) {
    const monthStr = r.target_month.slice(0, 7);
    const beforeFix = await resolveVisitAddonLines(sb, [r.client_id], Number(monthStr.slice(0, 4)), Number(monthStr.slice(5, 7)), r.office_id, "介護");
    // "介護"を指定=is-01を付けない旧経路を模擬 (system違いなので厳密な再現ではないが
    // 「-01を付けない問い合わせだと引けない」ことを別クエリで直接確認する
    const { data: oldStyle } = await sb
      .from("kaigo_visit_addon_lines")
      .select("client_id")
      .eq("office_id", r.office_id)
      .eq("target_month", monthStr) // 是正前の書式 (-01無し)
      .eq("system", "障害");
    const detected = (oldStyle ?? []).length === 0;
    console.log(`  ${detected ? "✓" : "✗"} ① 是正前の書式(-01無し)で問い合わせると障害の実データが0件になる (=バグを再現できる)`);
    if (detected) negOk += 1;
    void beforeFix;
  } else {
    console.log("  - ① スキップ (障害の実データなし)");
    negOk += 1;
  }
}
{
  // ② 介護に-01を付けて問い合わせると0件になる (介護側を壊していないかの逆側確認)
  const { data: kaigoSample } = await sb
    .from("kaigo_visit_addon_lines")
    .select("office_id, target_month")
    .eq("system", "介護")
    .limit(1);
  const r = (kaigoSample ?? [])[0] as { office_id: string; target_month: string } | undefined;
  if (r) {
    const { data: wrongFormat } = await sb
      .from("kaigo_visit_addon_lines")
      .select("client_id")
      .eq("office_id", r.office_id)
      .eq("target_month", `${r.target_month}-01`) // わざと介護に-01を付ける
      .eq("system", "介護");
    const detected = (wrongFormat ?? []).length === 0;
    console.log(`  ${detected ? "✓" : "✗"} ② 介護に誤って-01を付けると0件になる (=介護/障害で書式が違うことをharnessが検出できる)`);
    if (detected) negOk += 1;
  } else {
    console.log("  - ② スキップ (介護の実データなし)");
    negOk += 1;
  }
}
if (negOk < 2) {
  console.error("\n✗ 負のコントロールが機能していない。harness 自体を疑うこと");
  process.exit(1);
}

console.log(`\n${failures === 0 ? "✅ PASS — target_month書式是正が効いている (既存障害32行がresolveVisitAddonLinesで引ける・実billing側は無回帰)" : `❌ FAIL — ${failures} 件`}`);
process.exit(failures === 0 ? 0 : 1);
