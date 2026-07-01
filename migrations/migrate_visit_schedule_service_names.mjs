// kaigo_visit_schedule.service_type に格納された 旧 category ラベル
// (身体介護 / 生活援助 / 身体+生活 / 身体介護３) を、
// 令和6年 訪問介護 単位数表 の実サービスコード名に更新する。
//
// マッピング (時間帯 → コード):
//   身体介護 20分未満        → 身体介護01
//   身体介護 20-30分未満      → 身体介護02
//   身体介護 30-60分未満      → 身体介護1
//   身体介護 60-90分未満      → 身体介護2
//   身体介護 90-120分未満     → 身体介護3
//   身体介護 120-150分未満    → 身体介護4
//   身体介護 150-180分未満    → 身体介護5
//   身体介護 180分以上        → 身体介護6
//   生活援助 20-45分未満      → 生活援助2
//   生活援助 45分以上         → 生活援助3
//   身体+生活                → 身体介護1・生活1 (代表 = 身体 30-60分 + 生活 20分程度)
//
// 実行:
//   node migrations/migrate_visit_schedule_service_names.mjs
//   node migrations/migrate_visit_schedule_service_names.mjs --execute
import { createClient } from "@supabase/supabase-js";
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error("env missing"); process.exit(1); }
const EXECUTE = process.argv.includes("--execute");
const sb = createClient(SB_URL, SB_KEY);

function diffMinutes(start, end) {
  if (!start || !end) return null;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let d = eh * 60 + em - (sh * 60 + sm);
  if (d < 0) d += 24 * 60;
  return d;
}

function mapService(oldType, minutes) {
  if (oldType === "身体介護") {
    if (minutes == null) return "身体介護1";
    if (minutes < 20) return "身体介護01";
    if (minutes < 30) return "身体介護02";
    if (minutes < 60) return "身体介護1";
    if (minutes < 90) return "身体介護2";
    if (minutes < 120) return "身体介護3";
    if (minutes < 150) return "身体介護4";
    if (minutes < 180) return "身体介護5";
    return "身体介護6";
  }
  if (oldType === "生活援助") {
    if (minutes == null) return "生活援助2";
    if (minutes < 45) return "生活援助2";
    return "生活援助3";
  }
  if (oldType === "身体+生活") {
    return "身体介護1・生活1";
  }
  if (oldType === "身体介護３") {
    return "身体介護3";
  }
  return null;  // 対象外
}

async function main() {
  console.log(`\n📂 kaigo_visit_schedule.service_type 実コード名化`);
  console.log(EXECUTE ? "⚠️  EXECUTE MODE" : "🔍 DRY RUN");

  // 対象行取得: 旧 category ラベルのみ
  const OLD_LABELS = ["身体介護", "生活援助", "身体+生活", "身体介護３"];
  const { data: rows, error } = await sb.from("kaigo_visit_schedule")
    .select("id, service_type, start_time, end_time")
    .in("service_type", OLD_LABELS);
  if (error) { console.error(error); process.exit(1); }
  console.log(`  対象 ${rows.length} 行`);

  // 変換
  const updates = [];
  const stats = {};
  for (const r of rows) {
    const mins = diffMinutes(r.start_time?.slice(0,5), r.end_time?.slice(0,5));
    const next = mapService(r.service_type, mins);
    if (!next || next === r.service_type) continue;
    updates.push({ id: r.id, service_type: next });
    stats[`${r.service_type} → ${next}`] = (stats[`${r.service_type} → ${next}`] ?? 0) + 1;
  }
  console.log(`\n変換予定: ${updates.length} 行`);
  Object.entries(stats).sort().forEach(([k,v]) => console.log(`  ${k}: ${v}`));

  if (!EXECUTE) { console.log("\n(DRY RUN)"); return; }
  if (updates.length === 0) { console.log("変更なし"); return; }

  let ok = 0, ng = 0;
  for (const u of updates) {
    const { error: e } = await sb.from("kaigo_visit_schedule")
      .update({ service_type: u.service_type }).eq("id", u.id);
    if (e) { ng++; console.error(`  ❌ ${u.id.slice(0,8)}: ${e.message}`); }
    else ok++;
  }
  console.log(`\n✅ 完了: ${ok} 成功 / ${ng} 失敗`);
}

main().catch(e => { console.error(e); process.exit(1); });
