// ============================================================================
// buildDailySessions の判定ロジックを「バイト単位で同一のコード」で単体検証する
// (DB・ファイル I/O 一切なし。読み取り専用の手計算チェック)。
//
//   import_meisai_shougai_records.mjs 654〜695行目の toMinOfDay / buildDailySessions を
//   そのままコピー (関数がファイル内 non-export のため import できない)。
//   差分が出た場合は本体を直接 diff すること。
// ============================================================================
import { SCENARIOS } from "./_2hour_rule_test_scenarios.mjs";

// ---- 本体からそのままコピー (654〜695行目) ----
function toMinOfDay(hm) {
  const m = /^(\d{1,2}):(\d{2})/.exec((hm || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
const MERGE_GAP_MINUTES = Number(process.env.MERGE_GAP_MINUTES ?? 120);
const MERGE_GAP_DIFF_STAFF_MINUTES = Number(process.env.MERGE_GAP_DIFF_STAFF_MINUTES ?? 60);
function buildDailySessions(rows) {
  const withTimes = rows
    .map((r) => ({ r, s: toMinOfDay(r.santeiStart), e: toMinOfDay(r.santeiEnd) }))
    .filter((it) => it.s != null && it.e != null && it.e > it.s)
    .sort((a, b) => a.s - b.s || a.e - b.e);
  const sessions = [];
  let cur = null;
  for (const it of withTimes) {
    const sameStaff = cur && cur.staffName != null && cur.staffName === (it.r.staffName ?? null);
    const limit = sameStaff ? MERGE_GAP_MINUTES : MERGE_GAP_DIFF_STAFF_MINUTES;
    if (cur && it.s - cur.lastEnd <= (sameStaff ? limit - 1 : limit)) {
      cur.members.push(it.r);
      cur.lastEnd = Math.max(cur.lastEnd, it.e);
      cur.staffName = it.r.staffName ?? null;
    } else {
      cur = { members: [it.r], lastEnd: it.e, staffName: it.r.staffName ?? null };
      sessions.push(cur);
    }
  }
  return sessions.map((s) => s.members);
}
// ---- コピーここまで ----

let pass = 0, fail = 0;
for (const sc of SCENARIOS) {
  const rows = sc.visits.map((v, i) => ({ idx: i, staffName: v.staff, santeiStart: v.start, santeiEnd: v.end }));
  const sessions = buildDailySessions(rows);
  const actualGroups = sessions.map((mem) => mem.map((r) => r.idx));
  const expectedGroups = sc.expectedGroups.map((g) => g.memberIdx);
  const ok = JSON.stringify(actualGroups) === JSON.stringify(expectedGroups);
  console.log(`${ok ? "OK  " : "NG !"} ${sc.id}  ${sc.desc}`);
  console.log(`      gap=[${sc.visits.slice(1).map((v) => v.gapBefore).join(",")}]  期待=${JSON.stringify(expectedGroups)}  実際=${JSON.stringify(actualGroups)}`);
  if (ok) pass++; else fail++;
}
console.log(`\n=== unit check: ${pass} OK / ${fail} NG (全${SCENARIOS.length}シナリオ) ===`);
if (fail) process.exit(1);
