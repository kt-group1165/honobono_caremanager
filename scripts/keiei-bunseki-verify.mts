/**
 * 経営分析 共有データ層 (keiei-bunseki.ts) の純関数部分の検証 (DB 不使用)
 *
 *   npx tsx scripts/keiei-bunseki-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   月ユーティリティ (境界値の宝庫: 年またぎ・上限打ち切り・不正入力) と
 *   サービス種類分類 / 単位数解決 / computeVisitAnalysis (訪問系の月次集計、
 *   DBを呼ばない完全な純関数)が、これまで一つも検証されていなかった。
 *
 *   ★ computeVisitAnalysis の newUsers/endedUsers 判定は実際の事故を踏まえた
 *   ガード (ファイル内コメントに明記): 2026-06 は新規2,270/2,271名、2026-07は
 *   終了2,075名と出たが「誰も辞めていない」— 実績の取込量が月でばらつくため。
 *   ガード条件 (前月0件/4倍以上の差) を境界値で固定化する。
 *
 *   居宅側の computeKyotakuAnalysis は今回のスコープに含めない (別途)。
 */
import {
  monthsInRangeCapped,
  prevMonthKey,
  reiwaMonthLabel,
  monthStartEnd,
  durationMinutes,
  isMissingSchemaError,
  systemOfService,
  unitsForMonth,
  classifyServiceType,
  computeVisitAnalysis,
  type ServiceMaster,
  type ServiceCodeGen,
  type MonthVisitData,
  type KeieiSchedRow,
} from "@/lib/keiei-bunseki";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

// ── monthsInRangeCapped ───────────────────────────────────────────────────
eq("同月同士は1件", monthsInRangeCapped("2026-06", "2026-06"), ["2026-06"]);
eq("★ 年またぎを正しく生成する", monthsInRangeCapped("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
eq("★ from > to は空配列", monthsInRangeCapped("2026-06", "2026-01"), []);
eq("不正な形式 (YYYY-MM でない) は空配列", monthsInRangeCapped("2026/06", "2026-07"), []);
eq("★ cap超過時は直近側 (末尾) を優先して切り詰める", monthsInRangeCapped("2020-01", "2026-06", 3), ["2026-04", "2026-05", "2026-06"]);
eq("cap ちょうどなら切り詰めない", monthsInRangeCapped("2026-04", "2026-06", 3), ["2026-04", "2026-05", "2026-06"]);

// ── prevMonthKey ──────────────────────────────────────────────────────────
eq("通常月", prevMonthKey("2026-06"), "2026-05");
eq("★ 年をまたぐ (1月の前月は前年12月)", prevMonthKey("2026-01"), "2025-12");
eq("不正な形式はそのまま返す", prevMonthKey("不正"), "不正");

// ── reiwaMonthLabel ───────────────────────────────────────────────────────
eq("R8/6 表記になる", reiwaMonthLabel("2026-06"), "R8/6");
eq("★ 月の0埋めを外す (6月であって06月でない)", reiwaMonthLabel("2026-06").includes("06"), false);
eq("不正な形式はそのまま返す", reiwaMonthLabel("不正"), "不正");

// ── monthStartEnd ─────────────────────────────────────────────────────────
eq("31日月", monthStartEnd("2026-01"), { start: "2026-01-01", end: "2026-01-31" });
eq("30日月", monthStartEnd("2026-04"), { start: "2026-04-01", end: "2026-04-30" });
eq("★ 平年2月は28日", monthStartEnd("2026-02"), { start: "2026-02-01", end: "2026-02-28" });
eq("★ うるう年2月は29日 (2028年)", monthStartEnd("2028-02"), { start: "2028-02-01", end: "2028-02-29" });
eq("★ 不正形式は -31 固定でフォールバックする (呼出側の既知の仕様)", monthStartEnd("不正"), { start: "不正-01", end: "不正-31" });

// ── durationMinutes ───────────────────────────────────────────────────────
eq("通常 (09:00-10:30 = 90分)", durationMinutes("09:00", "10:30"), 90);
eq("秒付きでも先頭5文字だけ見る", durationMinutes("09:00:00", "10:30:15"), 90);
eq("★ end <= start は 0 (逆転・同時刻)", durationMinutes("10:00", "09:00"), 0);
eq("同時刻は0", durationMinutes("10:00", "10:00"), 0);
eq("null は0", durationMinutes(null, "10:00"), 0);
eq("不正な時刻文字列は0", durationMinutes("abc", "10:00"), 0);

// ── isMissingSchemaError ──────────────────────────────────────────────────
for (const code of ["42P01", "PGRST205", "42703", "PGRST204"]) {
  eq(`${code} は missing schema`, isMissingSchemaError(code), true);
}
eq("未知のコードは false", isMissingSchemaError("23505"), false);
eq("null は false", isMissingSchemaError(null), false);

// ── ServiceMaster helper ─────────────────────────────────────────────────
const gen = (o: Partial<ServiceCodeGen> & { service_name: string }): ServiceCodeGen => ({
  units: null,
  system: null,
  valid_from: null,
  valid_until: null,
  ...o,
});
const buildMaster = (rows: ServiceCodeGen[]): ServiceMaster => {
  const m: ServiceMaster = new Map();
  for (const r of rows) {
    const k = r.service_name; // テストでは正規化済み名前をそのまま使う
    const arr = m.get(k);
    if (arr) arr.push(r);
    else m.set(k, [r]);
  }
  return m;
};

// ── systemOfService ───────────────────────────────────────────────────────
{
  const master = buildMaster([
    gen({ service_name: "身体日0.5", system: "障害", units: 100 }),
    gen({ service_name: "身体日0.5", system: "介護", units: 200 }),
  ]);
  eq("★ 複数制度がヒットしたら 介護 > 総合事業 > 独自 > 障害 の優先順位", systemOfService(master, "身体日0.5"), "介護");
  eq("未登録の名前は null", systemOfService(master, "存在しない"), null);
}

// ── unitsForMonth ─────────────────────────────────────────────────────────
{
  const master = buildMaster([
    gen({ service_name: "身体介護1", system: "介護", units: 163, valid_from: "2024-06-01", valid_until: "2026-05-31" }),
    gen({ service_name: "身体介護1", system: "介護", units: 168, valid_from: "2026-06-01", valid_until: null }),
  ]);
  eq("★ 旧世代の期間内なら旧単位数", unitsForMonth(master, "身体介護1", "2026-03"), 163);
  eq("★ 改定月から新単位数に切り替わる", unitsForMonth(master, "身体介護1", "2026-06"), 168);
  eq("現行世代 (valid_until null) は将来もずっと有効", unitsForMonth(master, "身体介護1", "2030-01"), 168);
  eq("解決不能な名前は null", unitsForMonth(master, "存在しない", "2026-06"), null);
  eq("不正な月形式は null", unitsForMonth(master, "身体介護1", "不正"), null);

  const masterUnitsNull = buildMaster([
    gen({ service_name: "加算のみ行", system: "介護", units: null, valid_from: null, valid_until: null }),
  ]);
  eq("★ units が null の世代は候補から除外される (単位数を持たない加算行等)", unitsForMonth(masterUnitsNull, "加算のみ行", "2026-06"), null);
}

// ── classifyServiceType ───────────────────────────────────────────────────
{
  const master = buildMaster([gen({ service_name: "身体日0.5", system: "障害", units: 100 })]);
  eq("★ マスタの system=障害 が最優先 (名前の見た目に依らない)", classifyServiceType("身体日0.5", master), "障害");

  const empty: ServiceMaster = new Map();
  eq("訪問入浴の接頭辞", classifyServiceType("訪問入浴介護", empty), "入浴");
  eq("★ 身体+生活の複合 (身生) が単純な身体判定より先に評価される", classifyServiceType("身体介護2・生活援助1", empty), "身生");
  eq("身体単独", classifyServiceType("身体介護1", empty), "身体");
  eq("生活単独", classifyServiceType("生活援助2", empty), "生活");
  eq("通院等乗降介助", classifyServiceType("通院等乗降介助", empty), "乗降");
  eq("総合事業フォールバック (マスタ未解決)", classifyServiceType("訪問型サービス", empty), "総合");
  eq("★ 障害フォールバック (マスタ未解決でも代表的な名前は分類できる)", classifyServiceType("重度訪問介護", empty), "障害");
  eq("未知のサービス名はその他", classifyServiceType("謎のサービス", empty), "その他");
  eq("null/undefinedはその他", classifyServiceType(null, empty), "その他");
  eq("空文字/空白のみはその他", classifyServiceType("   ", empty), "その他");
}

// ── computeVisitAnalysis ──────────────────────────────────────────────────
{
  const sched = (o: Partial<KeieiSchedRow> & { user_id: string }): KeieiSchedRow => ({
    staff_id: null, staff_id_2: null, staff_id_3: null,
    start_time: null, end_time: null,
    staff2_start_time: null, staff2_end_time: null, staff3_start_time: null, staff3_end_time: null,
    additional_staff: null, service_type: "身体介護1", status: "confirmed", notes: null,
    ...o,
  });
  const master: ServiceMaster = new Map();

  // ① 基本の集計: 訪問数・キャンセル・分・カテゴリ
  {
    const data: MonthVisitData = {
      month: "2026-06",
      schedules: [
        sched({ user_id: "c1", staff_id: "s1", start_time: "09:00", end_time: "10:00", service_type: "身体介護1" }),
        sched({ user_id: "c2", staff_id: "s1", start_time: "10:00", end_time: "10:30", service_type: "生活援助1" }),
        sched({ user_id: "c3", staff_id: "s2", status: "cancelled" }),
      ],
      bathClientIds: ["c4"],
    };
    const byMonth = new Map([["2026-06", data]]);
    const { monthly } = computeVisitAnalysis(["2026-06"], "2026-05", byMonth, master);
    const m = monthly[0];
    eq("visits はキャンセルを除いた件数", m.visits, 2);
    eq("cancelled はキャンセル件数", m.cancelled, 1);
    eq("minutes は非キャンセル行の合計 (60+30)", m.minutes, 90);
    eq("byCategory: 身体1件・生活1件", [m.byCategory.身体, m.byCategory.生活], [1, 1]);
    eq("★ 入浴は bathClientIds.length を別加算する (schedules とは独立)", m.byCategory.入浴, 1);
    eq("★ cancelRate = cancelled / (visits+cancelled) × 100", m.cancelRate, (1 / 3) * 100);
    eq("users は非キャンセルの訪問ユニーク利用者 + 入浴 (c1,c2,c4)", m.users, 3);
  }

  // ② cancelRate の0件境界
  {
    const data: MonthVisitData = { month: "2026-06", schedules: [], bathClientIds: [] };
    const byMonth = new Map([["2026-06", data]]);
    const { monthly } = computeVisitAnalysis(["2026-06"], "2026-05", byMonth, master);
    eq("★ 分母0 (訪問0件) の月は cancelRate が null (0%ではない)", monthly[0].cancelRate, null);
  }

  // ③ newUsers/endedUsers のガード — ★ 実際の事故 (2026-09-03) の再現テスト
  {
    // (a) 前月データが0件 → 判定不能
    const prev: MonthVisitData = { month: "2026-05", schedules: [], bathClientIds: [] };
    const cur: MonthVisitData = {
      month: "2026-06",
      schedules: [sched({ user_id: "c1" }), sched({ user_id: "c2" })],
      bathClientIds: [],
    };
    const byMonth1 = new Map([["2026-05", prev], ["2026-06", cur]]);
    const r1 = computeVisitAnalysis(["2026-06"], "2026-05", byMonth1, master).monthly[0];
    eq("★ 前月0件なら newUsers/endedUsers は null (「全員新規」と誤判定しない)", [r1.newUsers, r1.endedUsers], [null, null]);
    eq("理由が入る", r1.newUsersReason !== null, true);

    // (b) 前月・当月とも十分にあり、量が近い → 正しく差分を出す
    const prev2: MonthVisitData = {
      month: "2026-05",
      schedules: [sched({ user_id: "a" }), sched({ user_id: "b" }), sched({ user_id: "c" }), sched({ user_id: "d" })],
      bathClientIds: [],
    };
    const cur2: MonthVisitData = {
      month: "2026-06",
      schedules: [sched({ user_id: "b" }), sched({ user_id: "c" }), sched({ user_id: "d" }), sched({ user_id: "e" })],
      bathClientIds: [],
    };
    const byMonth2 = new Map([["2026-05", prev2], ["2026-06", cur2]]);
    const r2 = computeVisitAnalysis(["2026-06"], "2026-05", byMonth2, master).monthly[0];
    eq("★ 正常時は新規1名 (e) / 終了1名 (a) を正しく検出する", [r2.newUsers, r2.endedUsers], [1, 1]);
    eq("理由は null (判定できている)", r2.newUsersReason, null);

    // (c) ★ 実際の事故と同じ形: 前月がほぼ空 (実績取込量が月で大きく違う)
    const prev3: MonthVisitData = { month: "2026-05", schedules: [sched({ user_id: "x" })], bathClientIds: [] };
    const cur3: MonthVisitData = {
      month: "2026-06",
      schedules: Array.from({ length: 20 }, (_, i) => sched({ user_id: `u${i}` })),
      bathClientIds: [],
    };
    const byMonth3 = new Map([["2026-05", prev3], ["2026-06", cur3]]);
    const r3 = computeVisitAnalysis(["2026-06"], "2026-05", byMonth3, master).monthly[0];
    eq("★ 4倍以上の差があれば「全員新規」と誤判定せず null にする (2026-09-03の実事故)", [r3.newUsers, r3.endedUsers], [null, null]);

    // (d) 境界: ちょうど4倍は「大きく違う」扱い (min*4 < max)
    const prev4: MonthVisitData = { month: "2026-05", schedules: Array.from({ length: 5 }, (_, i) => sched({ user_id: `p${i}` })), bathClientIds: [] };
    const cur4: MonthVisitData = { month: "2026-06", schedules: Array.from({ length: 20 }, (_, i) => sched({ user_id: `c${i}` })), bathClientIds: [] };
    const byMonth4 = new Map([["2026-05", prev4], ["2026-06", cur4]]);
    const r4 = computeVisitAnalysis(["2026-06"], "2026-05", byMonth4, master).monthly[0];
    eq("★ ちょうど4倍 (5 vs 20) は境界上で null 側 (min*4 < max は 20<20 で偽 → 判定するに注意)", r4.newUsersReason, null);
  }

  // ④ 職員稼働の集計 (additional_staff 優先、旧列とのミラー二重計上防止)
  {
    const data: MonthVisitData = {
      month: "2026-06",
      schedules: [
        sched({
          user_id: "c1", staff_id: "s1", start_time: "09:00", end_time: "10:00",
          staff_id_2: "s2", staff2_start_time: "09:00", staff2_end_time: "10:00", // 旧列 (additional_staffがあれば無視されるべき)
          additional_staff: [{ staff_id: "s2", start_time: "09:30", end_time: "10:00" }],
        }),
      ],
      bathClientIds: [],
    };
    const byMonth = new Map([["2026-06", data]]);
    const { staff } = computeVisitAnalysis(["2026-06"], "2026-05", byMonth, master);
    const s2 = staff.find((s) => s.staffId === "s2");
    eq("★ additional_staff がある場合は staff_id_2 と二重計上しない (s2は1回だけ計上)", s2?.totalVisits, 1);
    eq("★ additional_staff の個別時間 (09:30-10:00=30分) を使う (旧列の09:00-10:00=60分ではない)", s2?.totalMinutes, 30);
    const s1 = staff.find((s) => s.staffId === "s1");
    eq("主担当は主の時間で計上される", s1?.totalMinutes, 60);
  }
}

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① 前月0件のガードを実装しない壊れた版 (全員新規と誤判定する)
  const sched = (userId: string): KeieiSchedRow => ({
    user_id: userId, staff_id: null, staff_id_2: null, staff_id_3: null,
    start_time: null, end_time: null, staff2_start_time: null, staff2_end_time: null,
    staff3_start_time: null, staff3_end_time: null, additional_staff: null,
    service_type: "身体介護1", status: "confirmed", notes: null,
  });
  const master: ServiceMaster = new Map();
  const prev: MonthVisitData = { month: "2026-05", schedules: [], bathClientIds: [] };
  const cur: MonthVisitData = { month: "2026-06", schedules: [sched("c1"), sched("c2")], bathClientIds: [] };
  const byMonth = new Map([["2026-05", prev], ["2026-06", cur]]);
  const correct = computeVisitAnalysis(["2026-06"], "2026-05", byMonth, master).monthly[0];
  const brokenNewUsers = 2; // ★ ガード無しで単純差分を出す壊れた実装 (2026-09-03の実事故と同じ)
  const detected1 = correct.newUsers === null && brokenNewUsers !== null;
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: 前月0件ガードの有無を検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ 前月0件でも新規数を出してしまう(2026-09-03の実事故と同型)バグを検出できる (正=${JSON.stringify(correct.newUsers)} / 壊れた版=${brokenNewUsers})`);

  // ② durationMinutes で逆転時刻を弾かない壊れた実装
  const correctDur = durationMinutes("10:00", "09:00");
  const brokenDur = (() => {
    const p = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
    return p("09:00".slice(0, 5)) - p("10:00".slice(0, 5)); // ★ e<=sのガード無し (負の値になる)
  })();
  const detected2 = correctDur !== brokenDur;
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: 時刻逆転ガードの有無を検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ 時刻逆転(end<=start)を弾かないバグを検出できる (正=${correctDur} / 壊れた版=${brokenDur})`);
}

console.log(`\n経営分析 共有データ層 (純関数部分・訪問系) の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
