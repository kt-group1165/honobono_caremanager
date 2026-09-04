// ============================================================================
// 給与計算 (居宅の出勤簿) サンプル (SAMPLE_DATA_PROTOCOL 準拠 / マーカー = c)
//
//   node migrations/seed_sample_payroll_c.mjs             # DRY RUN
//   node migrations/seed_sample_payroll_c.mjs --delete    # ★ 撤去
//   node migrations/seed_sample_payroll_c.mjs --execute   # 投入
//
// ⚠ **payroll 側の表を触る。**共通の _sample_data.mjs は kaigo-app 側しか消さないので
//   撤去はこの script が自前で行う (payroll_employees / payroll_kyotaku_salary /
//   payroll_kyotaku_attendance_records)。
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
//   calcDaily / calcOvertimePayBreakdown を通る実データは **居宅の職員 10 名だけ**で、
//   境界 (月60h ちょうど・0 時またぎ・法定休日・月またぎ週) を 1 つも踏めていない。
//   純関数は合格しているが、**DB → 集計 → 給与 の経路**は通っていない。
//
// ── 入れるバリエーション ────────────────────────────────────────────────
//   ZP01 月60h **ちょうど** (3,600 分)  → 60h 超過分は 0 のはず
//   ZP02 月60h **+1 分** (3,601 分)     → 1 分だけ 1.5 倍になるはず
//   ZP03 **0 時またぎ** の深夜勤務 (22:00-06:00) を 4 日
//   ZP04 **欠勤あり** (平日に未入力でなく「勤務時間が短い」日を作る)
//        ★ 最優先: 欠勤が **控除額を動かすか** を見る
//   ZP05 **月またぎ週** (11/30 月曜 から 12 月へ続く週) + 法定休日 (7 日連続勤務)
//
//   マーカー: employee_number = "ZP0n" / name 末尾 "[sample-c]"
//   対象月   2026-12 (11/30 は月またぎ週の検証に必要な最小限)
//   事業所   実在の payroll_offices を使う。**offices は変更しない**
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");
const MONTH = "2026-12";
const TENANT = "kt-group";
const MARK = "[sample-c-20260903]";
const NAME_SUFFIX = "[sample-c]";
const NUM_PREFIX = "ZP";
// ⚠ CHECK を実値で確認した (CLAUDE.md 4.1 / SAMPLE_DATA_PROTOCOL):
//    payroll_employees.employment_status = "在職者"/"退職者"/"休職者"  (**「在籍」ではない**)
//    payroll_employees.salary_type       = "時給"/"月給"
//    payroll_employees.role_type         = "パート"/"社員"/"管理者"  (「ケアマネ」ではない)

const env = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/**
 * 給与設定は全員同じにして**時給を 2,000 円ちょうど**にする。
 *   本人給 100,000 + 職能給 220,000 = 320,000 / 所定 160h = 2,000 円/h
 * 固定残業代は 0 にして、超過額 = 残業代そのものになるようにする。
 */
const SALARY = { honnin_kyu: 100000, shokuno_kyu: 220000, kotei_zangyo: 0,
  shikaku_teate: 0, kotei: 0, tokutei_shogu: 0, kaigo_rate: 0, shien_rate: 0 };

const PEOPLE = [
  { no: "ZP01", name: "給与 ちょうど", memo: "月60h ちょうど (3,600分)" },
  { no: "ZP02", name: "給与 プラス1", memo: "月60h +1分 (3,601分)" },
  { no: "ZP03", name: "給与 深夜", memo: "0時またぎ 22:00-06:00 ×4日" },
  { no: "ZP04", name: "給与 欠勤", memo: "★欠勤あり (控除が動くか)" },
  { no: "ZP05", name: "給与 月またぎ", memo: "月またぎ週 + 7日連続勤務 (法定休日)" },
];

const p2 = (n) => String(n).padStart(2, "0");
const d = (day) => `${MONTH}-${p2(day)}`;
/** 出勤簿 1 行 */
const rec = (who, date, start, end, brk = 0, extra = {}) =>
  ({ who, work_date: date, start_time: start, end_time: end, break_minutes: brk, ...extra });

/**
 * ── 手計算 ────────────────────────────────────────────────────────────
 * 時給 2,000 / 日 8h 超が日次残業 / 週 40h 超が週次残業 / 月 60h 超は 1.5 倍
 *
 * ZP01: 12/1〜12/25 の平日 19 日。うち 12 日を 9h 勤務 (日次残業 1h ×12 = 720分)
 *       残り 7 日を 8h。→ 日次 720 分。週次は各週 40h 以内なので 0。
 *       ★ 合計 720 分 では 60h に届かないので、9h の日を増やして 3,600 分に合わせる
 *       → **1 日 12h (日次残業 4h) を 15 日** = 3,600 分ちょうど
 * ZP02: 同じく 15 日 + 1 分 → 3,601 分
 */
const shifts = [];
// ZP01 月60h ちょうど: 12h 勤務 (休憩 60 分) → 実働 11h = 日次残業 3h ... ではなく
//   12h 拘束 - 0 休憩 = 12h 実働 → 日次残業 4h。×15 日 = 60h = 3,600 分ちょうど
for (let i = 1; i <= 15; i++) shifts.push(rec("ZP01", d(i), "08:00", "20:00", 0));
// ZP02 3,601 分: 14 日は同じ + 1 日だけ 12h1m
for (let i = 1; i <= 14; i++) shifts.push(rec("ZP02", d(i), "08:00", "20:00", 0));
shifts.push(rec("ZP02", d(15), "08:00", "20:01", 0));
// ZP03 0 時またぎ 22:00-06:00 (8h) ×4 日。深夜は 22:00-05:00 = 7h/日
for (const day of [1, 8, 15, 22]) shifts.push(rec("ZP03", d(day), "22:00", "06:00", 0));
// ZP04 欠勤: 平日 5 日を 4h だけ勤務 (所定 8h に対し 4h 欠勤 ×5 = 1,200 分)
for (const day of [1, 2, 3, 4, 7]) shifts.push(rec("ZP04", d(day), "09:00", "13:00", 0));
// ZP05 月またぎ週 (11/30 月) + 12/1〜12/6 で 7 日連続 → 法定休日が付くはず
shifts.push(rec("ZP05", "2026-11-30", "09:00", "18:00", 60));
for (let i = 1; i <= 6; i++) shifts.push(rec("ZP05", d(i), "09:00", "18:00", 60));

const findSamples = async () => {
  const { data, error } = await sb.from("payroll_employees")
    .select("id, employee_number, name").like("employee_number", `${NUM_PREFIX}%`);
  if (error) throw new Error(`payroll_employees: ${error.message}`);
  return data ?? [];
};

async function doDelete() {
  console.log(`=== 撤去 (マーカー ${NUM_PREFIX}*) ===`);
  const emps = await findSamples();
  console.log(`  対象 payroll_employees: ${emps.length} 名 ${emps.map((e) => e.employee_number).join(",")}`);
  if (emps.length === 0) { console.log("  対象なし"); return; }
  const ids = emps.map((e) => e.id);
  // ⚠ 2026-09-04 是正: --delete 単体では消さない (--execute が要る)
  if (!EXECUTE) { console.log("【DRY RUN】--delete --execute で実際に削除します"); return; }
  for (const t of ["payroll_kyotaku_attendance_records", "payroll_kyotaku_salary"]) {
    const { error, count } = await sb.from(t).delete({ count: "exact" }).in("employee_id", ids);
    if (error) { console.error(`  ✗ ${t}: ${error.message}`); process.exitCode = 1; return; }
    console.log(`  ${t.padEnd(38)} ${count ?? 0} 行 削除`);
  }
  const { error, count } = await sb.from("payroll_employees").delete({ count: "exact" }).in("id", ids);
  if (error) { console.error(`  ✗ payroll_employees: ${error.message}`); process.exitCode = 1; return; }
  console.log(`  payroll_employees                      ${count ?? 0} 行 削除`);
  const left = await findSamples();
  console.log(`  ★ 残り ${left.length} 件 ${left.length === 0 ? "✅ 0 件を確認" : "❌ 残っている"}`);
}

async function doSeed() {
  console.log(`=== 給与サンプル投入 ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===`);
  console.log(`    対象月 ${MONTH} / マーカー ${NUM_PREFIX}* ・ ${NAME_SUFFIX}\n`);

  // 実在の居宅 payroll_office を 1 つ使う (変更はしない)
  const { data: offs, error: oe } = await sb.from("payroll_offices")
    .select("id, office_number, office_type, work_week_start").eq("office_type", "居宅介護支援").limit(1);
  if (oe) throw new Error(`payroll_offices: ${oe.message}`);
  if (!offs?.length) throw new Error("居宅介護支援の payroll_office が実在しない");
  const office = offs[0];
  console.log(`  事業所: ${office.office_number} (${office.office_type} / 週起算 ${office.work_week_start}) — **変更しない**`);

  console.log(`\n  投入予定: 職員 ${PEOPLE.length} 名 / 給与設定 ${PEOPLE.length} 行 / 出勤簿 ${shifts.length} 行`);
  for (const p of PEOPLE) {
    const n = shifts.filter((s) => s.who === p.no).length;
    console.log(`     ${p.no} ${p.name.padEnd(14)} 出勤簿 ${String(n).padStart(2)} 日  ${p.memo}`);
  }
  console.log(`\n  給与設定: 本人給 ${SALARY.honnin_kyu.toLocaleString()} + 職能給 ${SALARY.shokuno_kyu.toLocaleString()}`);
  console.log(`            = ${(SALARY.honnin_kyu + SALARY.shokuno_kyu).toLocaleString()} / 所定 160h → **時給 2,000 円ちょうど**`);
  console.log(`            固定残業代 0 (= 超過額が残業代そのものになる)`);

  const existing = await findSamples();
  if (existing.length > 0) { console.log(`\n  ⚠ 既に ${existing.length} 件あります。先に --delete してください`); return; }
  if (!EXECUTE) { console.log(`\n【DRY RUN】書き込んでいません。--execute で投入`); return; }

  const { data: ins, error: ie } = await sb.from("payroll_employees").insert(
    PEOPLE.map((p) => ({
      employee_number: p.no, name: `${p.name}${NAME_SUFFIX}`, office_id: office.id,
      salary_type: "月給", employment_status: "在職者", hire_date: "2020-04-01",
      role_type: "社員", social_insurance: true,
    })),
  ).select("id, employee_number");
  if (ie) { console.error(`✗ payroll_employees: ${ie.message}`); process.exit(1); }
  const idBy = new Map(ins.map((r) => [r.employee_number, r.id]));
  console.log(`  payroll_employees            ${ins.length} 行`);

  const { error: se } = await sb.from("payroll_kyotaku_salary").insert(
    PEOPLE.map((p) => ({ tenant_id: TENANT, employee_id: idBy.get(p.no),
      effective_from: "2020-04-01", ...SALARY })));
  if (se) { console.error(`✗ payroll_kyotaku_salary: ${se.message}`); process.exit(1); }
  console.log(`  payroll_kyotaku_salary       ${PEOPLE.length} 行`);

  const { error: re } = await sb.from("payroll_kyotaku_attendance_records").insert(
    shifts.map((s) => ({
      tenant_id: TENANT, office_id: office.id, employee_id: idBy.get(s.who),
      work_date: s.work_date, start_time: s.start_time, end_time: s.end_time,
      break_minutes: s.break_minutes, is_legal_holiday: false,
      note: MARK,
    })),
  );
  if (re) { console.error(`✗ payroll_kyotaku_attendance_records: ${re.message}`); process.exit(1); }
  console.log(`  payroll_kyotaku_attendance_records  ${shifts.length} 行`);

  const { count, error: qe } = await sb.from("payroll_kyotaku_attendance_records")
    .select("*", { count: "exact", head: true })
    .in("employee_id", [...idBy.values()]);
  if (qe) { console.error(`✗ 件数確認: ${qe.message}`); process.exit(1); }
  console.log(`\n  ★ 件数確認: サンプル職員の出勤簿 ${count} 行`);
}

(DELETE ? doDelete() : doSeed()).catch((e) => { console.error("✗ " + e.message); process.exit(1); });
