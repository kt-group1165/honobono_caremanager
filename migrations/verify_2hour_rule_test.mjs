// ============================================================================
// seed_2hour_rule_test_data.mjs + import_meisai_shougai_records.mjs (--execute) の
// 結果を、シナリオごとの期待値 (_2hour_rule_test_scenarios.mjs) と突合する。
// 読み取り専用 (SELECT のみ)。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { SCENARIOS, CLIENT_NAME } from "./_2hour_rule_test_scenarios.mjs";

const OFFICE_ID = "383a296f-f6b3-4088-bf67-c5d274d78a62";
const CLIENT_ID = "a6495a94-9442-4128-b55c-8fcf17eefa79";

function loadEnv() {
  const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function main() {
  const { data: rows, error } = await sb.from("kaigo_visit_schedule")
    .select("id,visit_date,start_time,end_time,staff_id,service_type,notes")
    .eq("office_id", OFFICE_ID).eq("user_id", CLIENT_ID)
    .order("visit_date").order("start_time");
  if (error) { console.error("✗ 取得失敗:", error.message); process.exit(1); }

  const { data: members } = await sb.from("members").select("id,name")
    .in("id", [...new Set(rows.map((r) => r.staff_id).filter(Boolean))]);
  const staffNameById = new Map((members ?? []).map((m) => [m.id, m.name]));

  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.visit_date)) byDate.set(r.visit_date, []);
    byDate.get(r.visit_date).push(r);
  }

  let pass = 0, fail = 0;
  for (const sc of SCENARIOS) {
    const dbRows = (byDate.get(sc.date) ?? []).sort((a, b) => a.start_time.localeCompare(b.start_time));
    const problems = [];

    // 期待される行数 = Σ(各グループ: merged?2:1 は誤り。base常に1 + record-only(merged時のみ人数-1))
    //   merged group (n件): base 1 + record-only (n-1) = n 行
    //   non-merged group (1件): 1 行
    //   → 結局グループ内訳に関わらず「合計行数 = visit数」になる
    const expectedRowCount = sc.visits.length;
    if (dbRows.length !== expectedRowCount) {
      problems.push(`行数不一致: 期待${expectedRowCount} 実際${dbRows.length}`);
    }

    for (const grp of sc.expectedGroups) {
      if (grp.merged) {
        // base 行 = grp.repStart 時刻・service_type=grp.code・notes に 合算従属 が付かない・[MEISAI障害取込 ...] (addonマーカー無し)
        const base = dbRows.find((r) => r.start_time?.slice(0, 5) === grp.repStart && !r.notes?.includes("合算従属"));
        if (!base) { problems.push(`base行が見つからない (${grp.repStart}開始 code期待=${grp.code})`); continue; }
        if (base.service_type !== grp.code) problems.push(`base service_type不一致: 期待${grp.code} 実際${base.service_type} (${grp.repStart})`);
        if (base.end_time?.slice(0, 5) !== grp.repEnd) problems.push(`base end_time不一致: 期待${grp.repEnd} 実際${base.end_time} (代表行=${grp.repStart})`);
        if (staffNameById.get(base.staff_id) !== grp.repStaff) problems.push(`base staff不一致: 期待${grp.repStaff} 実際${staffNameById.get(base.staff_id)} (${grp.repStart})`);
        if (!base.notes?.startsWith("[MEISAI障害取込")) problems.push(`base notesマーカー欠落: ${base.notes}`);

        // record-only 行 (2件目以降) = 各自の実時刻・service_type=grp.code(=repNameと同じ)・notes に 合算従属
        for (let k = 1; k < grp.memberIdx.length; k++) {
          const v = sc.visits[grp.memberIdx[k]];
          const sub = dbRows.find((r) => r.start_time?.slice(0, 5) === v.start && r.notes?.includes("合算従属"));
          if (!sub) { problems.push(`合算従属行が見つからない (${v.start}開始・担当${v.staff})`); continue; }
          if (sub.service_type !== grp.code) problems.push(`従属行 service_type不一致: 期待${grp.code} 実際${sub.service_type} (${v.start})`);
          if (sub.end_time?.slice(0, 5) !== v.end) problems.push(`従属行 end_time不一致: 期待${v.end} 実際${sub.end_time} (${v.start})`);
          if (staffNameById.get(sub.staff_id) !== v.staff) problems.push(`従属行 staff不一致: 期待${v.staff} 実際${staffNameById.get(sub.staff_id)} (${v.start})`);
        }
      } else {
        // 非合算 (単独行): service_type=0.5h単一コード, notesに合算従属もaddonも付かない
        const v = sc.visits[grp.memberIdx[0]];
        const solo = dbRows.find((r) => r.start_time?.slice(0, 5) === v.start);
        if (!solo) { problems.push(`単独行が見つからない (${v.start}開始)`); continue; }
        if (solo.service_type !== grp.code) problems.push(`単独行 service_type不一致: 期待${grp.code} 実際${solo.service_type} (${v.start})`);
        if (solo.notes?.includes("合算従属")) problems.push(`単独行なのに合算従属マーカーが付いている (${v.start})`);
        if (staffNameById.get(solo.staff_id) !== v.staff) problems.push(`単独行 staff不一致: 期待${v.staff} 実際${staffNameById.get(solo.staff_id)} (${v.start})`);
      }
    }

    const ok = problems.length === 0;
    console.log(`${ok ? "OK  " : "NG !"} ${sc.id}  ${sc.desc}`);
    if (!ok) for (const p of problems) console.log(`      - ${p}`);
    if (ok) pass++; else fail++;
  }

  console.log(`\n=== DB 突合: ${pass} OK / ${fail} NG (全${SCENARIOS.length}シナリオ) ===`);
  console.log(`(参考) 利用者=${CLIENT_NAME} / office=${OFFICE_ID} / DB総行数=${rows.length}`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error("ERROR:", e); process.exit(1); });
