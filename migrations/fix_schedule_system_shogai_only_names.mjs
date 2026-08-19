// ============================================================================
// kaigo_visit_schedule.system='介護' のうち、**介護にはあり得ないサービス名**の行を
// NULL (未設定) に戻す。
//
// ── 何が起きたか ──────────────────────────────────────────────────────
//   set_schedule_system_from_densou.mjs は「障害の実績記録票 (TJ) に (日付+開始時刻) が
//   有れば障害 / 無ければ介護」で振り分けていた。この "無ければ介護" が乱暴だった。
//   重度訪問介護は積み上げ型で 1 訪問が複数の段 (重訪Ⅱ日中１．０〜８．０) に分かれて
//   シフトに入っており、段ごとの時刻は TJ の 1 行と一致しない。結果 184 行の重訪が
//   「介護」と記録された。**重度訪問介護に介護保険は存在しない**ので明白な誤り。
//   総合事業 (訪問介護相当サービス…) も 8 行巻き込まれていた。
//
//   集計側は system='介護' の行を障害から除外するので、この誤記録がそのまま
//   **障害の請求漏れ**になる (中央・高品で実績記録票が実際にズレた)。
//
// ── 直し方 ────────────────────────────────────────────────────────────
//   サービス名が kaigo_service_codes (system='介護') に **1 件も無い**行は
//   介護ではありえないので system を NULL に戻す (= 名前解決に委ねる従来動作)。
//   障害と断定して '障害' を入れることはしない。TJ に無かった事実は残っており
//   「障害で請求された」根拠にはならないため。
//
//   node migrations/fix_schedule_system_shogai_only_names.mjs            # DRY RUN
//   node migrations/fix_schedule_system_shogai_only_names.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));

function loadEnv() {
  const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8");
  const e = {};
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return e;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function main() {
  console.log(`=== system='介護' の誤記録を戻す ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  // 1) system='介護' の行を全部取る (page-loop)
  const rows = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb
      .from("kaigo_visit_schedule")
      .select("id, service_type, visit_date, office_id")
      .eq("system", "介護")
      .order("id")
      .range(off, off + 999);
    if (error) { console.error(`✗ 取得失敗: ${error.message}`); process.exit(1); }
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  console.log(`system='介護' の行: ${rows.length} 件`);

  // 2) サービス名が介護マスタに存在するか (世代は問わない = 1 件でもあれば介護あり得る)
  const names = Array.from(new Set(rows.map((r) => (r.service_type ?? "").trim()).filter(Boolean)));
  const kaigoNames = new Set();
  for (let i = 0; i < names.length; i += 50) {
    const { data, error } = await sb
      .from("kaigo_service_codes")
      .select("service_name")
      .eq("system", "介護")
      .in("service_name", names.slice(i, i + 50));
    if (error) { console.error(`✗ マスタ照合失敗: ${error.message}`); process.exit(1); }
    for (const c of data ?? []) kaigoNames.add(c.service_name.trim());
  }

  const bad = rows.filter((r) => !kaigoNames.has((r.service_type ?? "").trim()));
  const agg = new Map();
  for (const r of bad) {
    const k = (r.service_type ?? "(空)").trim();
    agg.set(k, (agg.get(k) ?? 0) + 1);
  }
  console.log(`\n介護マスタに無い名前 = 誤記録: ${bad.length} 件\n`);
  for (const [k, v] of [...agg].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)}  ${k}`);
  }
  console.log(`\n残る (正しい介護): ${rows.length - bad.length} 件`);
  if (!bad.length) { console.log("\n直すものはありません。"); return; }
  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で NULL に戻します。"); return; }

  const ids = bad.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 100) {
    const { error } = await sb
      .from("kaigo_visit_schedule")
      .update({ system: null })
      .in("id", ids.slice(i, i + 100));
    if (error) { console.error(`✗ 更新失敗: ${error.message}`); process.exit(1); }
  }
  console.log(`\n✓ 完了: ${ids.length} 件を system=NULL に戻しました`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
