// サンプル訪問予定に「予定 + 実績」の両方が混在する状態を作る
//
// 1. 2026-07 の予定のうち 7/15 以前を status='completed' (実績) に UPDATE
//    → 後半 (7/16〜) は scheduled のまま = カレンダーで青/赤が混在
// 2. 2026-06 分として 7月の各行を 1 ヶ月前に複製 INSERT (全部 completed)
//    → 介護請求/利用請求/国保請求 の「先月分」集計も確認できる
//
// 実行:
//   node migrations/seed_schedule_planned_and_actual.mjs
//   node migrations/seed_schedule_planned_and_actual.mjs --execute
import { createClient } from "@supabase/supabase-js";
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error("env missing"); process.exit(1); }
const EXECUTE = process.argv.includes("--execute");
const sb = createClient(SB_URL, SB_KEY);

async function main() {
  console.log(`\n📂 予定 + 実績 混在サンプル seed`);
  console.log(EXECUTE ? "⚠️  EXECUTE MODE" : "🔍 DRY RUN");

  // ── 1) 2026-07 の予定を取得
  const { data: julyRows, error: e1 } = await sb
    .from("kaigo_visit_schedule")
    .select("*")
    .gte("visit_date", "2026-07-01")
    .lte("visit_date", "2026-07-31");
  if (e1) { console.error(e1); process.exit(1); }
  console.log(`7月分: ${julyRows.length} 件`);
  const statusCount = {};
  julyRows.forEach(r => statusCount[r.status] = (statusCount[r.status] ?? 0) + 1);
  console.log("  status 分布:", statusCount);

  // 7/15 以前で scheduled のもの → completed
  const toComplete = julyRows.filter(
    r => r.visit_date <= "2026-07-15" && r.status !== "completed"
  );
  console.log(`\n① 7/15 以前を実績化: ${toComplete.length} 件`);

  // ── 2) 6月分の複製 (全部 completed)
  const { data: juneExisting, error: e2 } = await sb
    .from("kaigo_visit_schedule")
    .select("id")
    .gte("visit_date", "2026-06-01")
    .lte("visit_date", "2026-06-30");
  if (e2) { console.error(e2); process.exit(1); }
  console.log(`\n② 6月分の既存: ${juneExisting.length} 件`);

  let juneInserts = [];
  if (juneExisting.length === 0) {
    juneInserts = julyRows.map(r => {
      // 7月の日付を 6月に移す (30 日まで。7/31 は 6/30 に丸め)
      const day = Math.min(Number(r.visit_date.slice(8, 10)), 30);
      return {
        tenant_id: r.tenant_id,
        user_id: r.user_id,
        staff_id: r.staff_id,
        visit_date: `2026-06-${String(day).padStart(2, "0")}`,
        start_time: r.start_time,
        end_time: r.end_time,
        service_type: r.service_type,
        pattern_id: r.pattern_id,
        status: "completed",
        notes: "[fake テスト用-june-actual]",
      };
    });
    console.log(`   → 7月の ${julyRows.length} 件を 6月に複製 (全部実績)`);
  } else {
    console.log("   → 既に 6月分あり、複製 skip");
  }

  if (!EXECUTE) { console.log("\n(DRY RUN, --execute で実行)"); return; }

  // 実行 ①
  let ok = 0, ng = 0;
  for (const r of toComplete) {
    const { error } = await sb
      .from("kaigo_visit_schedule")
      .update({ status: "completed" })
      .eq("id", r.id);
    if (error) { ng++; console.error(`  ❌ ${r.id.slice(0, 8)}:`, error.message); }
    else ok++;
  }
  console.log(`\n① 実績化: ${ok} 成功 / ${ng} 失敗`);

  // 実行 ②
  if (juneInserts.length > 0) {
    const { data, error } = await sb
      .from("kaigo_visit_schedule")
      .insert(juneInserts)
      .select("id");
    if (error) { console.error("② INSERT 失敗:", error.message); process.exit(1); }
    console.log(`② 6月分 INSERT: ${data.length} 件`);
  }

  console.log("\n完了");
}

main().catch(e => { console.error(e); process.exit(1); });
