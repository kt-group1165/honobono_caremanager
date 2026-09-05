/**
 * ヘルパー割当サジェスト (staff-suggest.ts) の純関数部分の検証 (DB 不使用)
 *
 *   npx tsx scripts/staff-suggest-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   suggestStaff は候補提示のみ (自動確定はしない) だが、ハード除外
 *   (時間帯重複・出勤可否NG) を間違えると「割当不可能な職員を候補に出す」
 *   実害があるため、DBを呼ばない完全な純関数でありながら1つも検証されて
 *   いなかった。
 *
 *   ★ isStaffUnavailableAtTime の「月次データはあるがその日の記録が無い
 *   職員は不可扱い」という非対称ルール (shift-management/_shared.ts) を
 *   suggestStaff 側の除外として正しく使えているかも合わせて確認する。
 */
import { suggestStaff, type SuggestScheduleRow } from "@/lib/staff-suggest";
import type { StaffAvailabilitySlot } from "@/app/(authenticated)/shift-management/_shared";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

const sched = (o: Partial<SuggestScheduleRow> & { id: string; user_id: string; visit_date: string }): SuggestScheduleRow => ({
  staff_id: null, staff_id_2: null, staff_id_3: null, additional_staff: null,
  start_time: null, end_time: null, status: "confirmed",
  ...o,
});

const baseParams = {
  staff: [
    { id: "s1", name: "佐藤" },
    { id: "s2", name: "鈴木" },
    { id: "s3", name: "田中" },
  ],
  userId: "c1",
  visitDate: "2026-06-15",
  startTime: "10:00",
  endTime: "11:00",
  schedules: [] as SuggestScheduleRow[],
  availability: [] as StaffAvailabilitySlot[],
  preferredIds: [] as string[],
  limit: 5,
};

// ── ① 時間帯重複はハード除外 ─────────────────────────────────────────────
{
  const schedules = [
    sched({ id: "e1", user_id: "cX", visit_date: "2026-06-15", staff_id: "s1", start_time: "10:30", end_time: "11:30" }), // s1と重なる
    sched({ id: "e2", user_id: "cX", visit_date: "2026-06-15", staff_id: "s2", start_time: "11:00", end_time: "12:00" }), // s2は隣接(重ならない)
  ];
  const r = suggestStaff({ ...baseParams, schedules });
  eq("★ 時間帯が重なる s1 は候補から除外される", r.some((x) => x.staffId === "s1"), false);
  eq("隣接 (重なりゼロ) の s2 は除外されない", r.some((x) => x.staffId === "s2"), true);
}
{
  // 部分重複の境界: 完全に連続 (end===start) は重複としない
  const schedules = [sched({ id: "e1", user_id: "cX", visit_date: "2026-06-15", staff_id: "s1", start_time: "09:00", end_time: "10:00" })];
  const r = suggestStaff({ ...baseParams, schedules });
  eq("★ 前の予定の終了 = 今回の開始 (09:00-10:00 と 10:00-11:00) は重複扱いしない", r.some((x) => x.staffId === "s1"), true);
}
{
  // cancelled の予定は重複判定に使わない
  const schedules = [sched({ id: "e1", user_id: "cX", visit_date: "2026-06-15", staff_id: "s1", start_time: "10:00", end_time: "11:00", status: "cancelled" })];
  const r = suggestStaff({ ...baseParams, schedules });
  eq("★ status=cancelled の予定は重複判定に含めない (除外されない)", r.some((x) => x.staffId === "s1"), true);
}
{
  // additional_staff も割当済みとして扱う
  const schedules = [sched({ id: "e1", user_id: "cX", visit_date: "2026-06-15", staff_id: "sOther", start_time: "10:00", end_time: "11:00", additional_staff: [{ staff_id: "s3", start_time: null, end_time: null }] })];
  const r = suggestStaff({ ...baseParams, schedules });
  eq("★ additional_staff で追加割当された職員も重複判定の対象になる", r.some((x) => x.staffId === "s3"), false);
}
{
  // 編集中の予定 (excludeScheduleId) は自分自身を重複扱いしない
  const schedules = [sched({ id: "editing", user_id: "cX", visit_date: "2026-06-15", staff_id: "s1", start_time: "10:00", end_time: "11:00" })];
  const r = suggestStaff({ ...baseParams, schedules, excludeScheduleId: "editing" });
  eq("★ excludeScheduleId を指定すると編集中の予定自体は重複除外の対象にならない", r.some((x) => x.staffId === "s1"), true);
}

// ── ② 出勤可否NG はハード除外 ────────────────────────────────────────────
{
  const availability: StaffAvailabilitySlot[] = [
    { staff_id: "s1", available_date: "2026-06-15", start_time: "10:00", end_time: "12:00", is_available: false },
  ];
  const r = suggestStaff({ ...baseParams, availability });
  eq("★ 出勤不可 (is_available=false) の重なる枠を持つ職員は除外される", r.some((x) => x.staffId === "s1"), false);
}
{
  // 月次データはあるがその日の記録が無い → 不可扱い (isStaffUnavailableAtTimeの非対称ルール)
  const availability: StaffAvailabilitySlot[] = [
    { staff_id: "s1", available_date: "2026-06-01", start_time: "09:00", end_time: "17:00", is_available: true },
  ];
  const r = suggestStaff({ ...baseParams, availability });
  eq("★ 月次データはあるが対象日の記録が無い職員は不可扱いで除外される", r.some((x) => x.staffId === "s1"), false);
}
{
  // 月次データが全く無い職員は判定しない (= 除外されない)
  const availability: StaffAvailabilitySlot[] = [
    { staff_id: "s2", available_date: "2026-06-15", start_time: "10:00", end_time: "12:00", is_available: false },
  ];
  const r = suggestStaff({ ...baseParams, availability });
  eq("★ 月次データが全く無い職員 (s1) は出勤可否を判定せず候補に残る", r.some((x) => x.staffId === "s1"), true);
}

// ── ③ 優先ヘルパーの加点 (1位+60、以降-10/位、下限+10) ────────────────────
{
  const r = suggestStaff({ ...baseParams, preferredIds: ["s2", "s1", "s3"] });
  const byId = Object.fromEntries(r.map((x) => [x.staffId, x]));
  eq("★ 優先1位 (s2) は score 60", byId.s2.score, 60);
  eq("★ 優先2位 (s1) は score 50 (60-10)", byId.s1.score, 50);
  eq("★ 優先3位 (s3) は score 40 (60-20)", byId.s3.score, 40);
  eq("優先ヘルパーの reasons に順位が入る", byId.s2.reasons.includes("優先1位"), true);
}
{
  // 下限10 のクランプ確認 (優先11位相当をシミュレート)
  const manyPreferred = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "s1"]; // s1が11番目 (idx=10)
  const r = suggestStaff({ ...baseParams, preferredIds: manyPreferred, staff: [{ id: "s1", name: "佐藤" }] });
  eq("★ 優先順位が下がっても加点は下限10でクランプされる (60-10*10=-40のはずが10)", r[0].score, 10);
}

// ── ④ 担当実績の加点 (回数×2、上限15回=30点) ──────────────────────────────
{
  const schedules = [
    sched({ id: "h1", user_id: "c1", visit_date: "2026-05-01", staff_id: "s1" }),
    sched({ id: "h2", user_id: "c1", visit_date: "2026-05-02", staff_id: "s1" }),
    sched({ id: "h3", user_id: "c1", visit_date: "2026-05-03", staff_id: "s2" }), // 別利用者ではなくc1、s2の実績
  ];
  const r = suggestStaff({ ...baseParams, schedules });
  const byId = Object.fromEntries(r.map((x) => [x.staffId, x]));
  eq("★ 担当実績 2回 → score 4 (2×2)", byId.s1.score, 4);
  eq("★ 担当実績 1回 → score 2", byId.s2.score, 2);
  eq("historyCount が正しく入る", byId.s1.historyCount, 2);
  eq("担当実績のreasonsに回数が入る", byId.s1.reasons.includes("担当実績2回"), true);
}
{
  // 上限クランプ: 20回担当していても加点は15回分 (30点) まで
  const schedules = Array.from({ length: 20 }, (_, i) => sched({ id: `h${i}`, user_id: "c1", visit_date: `2026-05-${String(i + 1).padStart(2, "0")}`, staff_id: "s1" }));
  const r = suggestStaff({ ...baseParams, schedules });
  const s1 = r.find((x) => x.staffId === "s1")!;
  eq("★ historyCount 自体は実数(20)を保持する", s1.historyCount, 20);
  eq("★ ただし score への加点は15回相当(30点)でクランプされる", s1.score, 30);
}
{
  // 別の利用者の担当実績はカウントしない
  const schedules = [sched({ id: "h1", user_id: "cOther", visit_date: "2026-05-01", staff_id: "s1" })];
  const r = suggestStaff({ ...baseParams, schedules });
  eq("★ 対象利用者(c1)以外の担当実績はhistoryCountに含めない", r.find((x) => x.staffId === "s1")?.historyCount, 0);
}

// ── 並び順・reasons・limit ────────────────────────────────────────────────
{
  const r = suggestStaff({ ...baseParams, preferredIds: ["s3"] });
  const noneStaff = r.find((x) => x.staffId === "s1")!;
  eq("★ 優先でも実績でもない職員は reasons が「空き」になる", noneStaff.reasons, ["空き"]);
}
{
  const r = suggestStaff({ ...baseParams, limit: 2 });
  eq("★ limit で件数が絞られる", r.length, 2);
}
{
  // score同点はhistoryCount降順、さらに同点なら名前順
  const schedules = [sched({ id: "h1", user_id: "c1", visit_date: "2026-05-01", staff_id: "s2" })];
  const r = suggestStaff({ ...baseParams, schedules }); // s2だけ実績1回、他は0点同士
  eq("★ score同点なら historyCount 降順が優先される (s2が最上位)", r[0].staffId, "s2");
  const zeroScoreOrder = r.slice(1).map((x) => x.staffId);
  eq("★ 完全同点は名前の五十音順 (佐藤s1 → 田中s3)", zeroScoreOrder, ["s1", "s3"]);
}

// ── excludeStaffIds ───────────────────────────────────────────────────────
{
  const r = suggestStaff({ ...baseParams, excludeStaffIds: ["s2"] });
  eq("★ excludeStaffIds で明示的に除外できる", r.some((x) => x.staffId === "s2"), false);
}

// ── 入力異常系 ────────────────────────────────────────────────────────────
eq("startTime が不正なら空配列", suggestStaff({ ...baseParams, startTime: "" }), []);
eq("visitDate が空文字なら空配列", suggestStaff({ ...baseParams, visitDate: "" }), []);

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① 時間帯重複判定を「開始時刻の一致」だけにする壊れた実装 (部分重複を見逃す)
  const schedules = [sched({ id: "e1", user_id: "cX", visit_date: "2026-06-15", staff_id: "s1", start_time: "10:30", end_time: "11:30" })];
  const r = suggestStaff({ ...baseParams, schedules });
  const correctExcluded = !r.some((x) => x.staffId === "s1");
  const brokenExcluded = false; // ★ 開始時刻だけ見る壊れた判定 (10:00 !== 10:30 なので除外されない)
  const detected1 = correctExcluded !== brokenExcluded;
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: 部分重複の検出漏れを検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ 部分重複(10:00-11:00 vs 10:30-11:30)を見逃すバグを検出できる (正=除外${correctExcluded} / 壊れた版=除外${brokenExcluded})`);

  // ② 担当実績のクランプを忘れる壊れた実装
  const manySchedules = Array.from({ length: 20 }, (_, i) => sched({ id: `h${i}`, user_id: "c1", visit_date: `2026-05-${String(i + 1).padStart(2, "0")}`, staff_id: "s1" }));
  const r2 = suggestStaff({ ...baseParams, schedules: manySchedules });
  const correctScore = r2.find((x) => x.staffId === "s1")!.score;
  const brokenScore = 20 * 2; // ★ Math.min(historyCount, 15) を忘れる
  const detected2 = correctScore !== brokenScore;
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: 担当実績クランプの有無を検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ 担当実績クランプ(上限15回)を忘れるバグを検出できる (正=${correctScore} / 壊れた版=${brokenScore})`);
}

console.log(`\nヘルパー割当サジェスト (純関数部分) の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
