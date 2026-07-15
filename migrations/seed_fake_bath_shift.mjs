// 訪問入浴シフト管理 (/bath-shift) サンプルデータ投入 (dry-run 付き)
//   node migrations/seed_fake_bath_shift.mjs            # DRY RUN
//   node migrations/seed_fake_bath_shift.mjs --execute  # 本番
//
// 対象: Ｈａｎａ訪問入浴 (52a60486)。号車×日 ルート方式のイメージ確認用。
//   - 架空職員 6 名 (看護師 2 + 介護 4、qualifications に marker)
//   - 架空利用者 15 名を割当 (OY001-010 + 居宅サンプル A001-E001)
//   - 号車 1号車/2号車 (既存があれば再利用)
//   - 週間パターン 40 本 → 2026-07 の予定 186 コマ生成 (1台1日 6〜7 件のルート)
//   - 当日編成 (7月の稼働日、7/17 の 2号車のみ看護なし = 減算警告デモ)
//   - 7/16 の 1号車は看護師が 09:00-12:00 のみ乗車 (staff_times、兼務デモ。
//     午後のコマに「看護なし(減算)」バッジが出る。列未適用なら自動スキップ)
//   - 7/1〜7/14 は実績反映済 (kaigo_bath_visit_records 40 件 + record_id リンク)
//
// クリーンアップ SQL:
//   DELETE FROM kaigo_bath_schedule       WHERE notes LIKE '%[fake テスト用-bath-shift]%';
//   DELETE FROM kaigo_bath_visit_records  WHERE notes LIKE '%[fake テスト用-bath-shift]%';
//   DELETE FROM kaigo_bath_patterns       WHERE notes LIKE '%[fake テスト用-bath-shift]%';
//   DELETE FROM kaigo_bath_team_days      WHERE notes LIKE '%[fake テスト用-bath-shift]%';
//   DELETE FROM client_office_assignments WHERE service_notes = '[fake 訪問入浴シフト]';
//   DELETE FROM member_offices WHERE member_id IN (SELECT id FROM members WHERE qualifications LIKE '%[fake テスト用-bath-shift]%');
//   DELETE FROM members WHERE qualifications LIKE '%[fake テスト用-bath-shift]%';

import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const OFFICE = { id: "52a60486-70a4-43d4-b786-82f4afa464c4", name: "Ｈａｎａ訪問入浴" };
const TENANT = "kt-group";
const MARKER = "[fake テスト用-bath-shift]";
const ASSIGN_MARKER = "[fake 訪問入浴シフト]";
const MONTH = "2026-07";
const ACTUAL_UNTIL = 14; // 7/14 まで実績反映済にする

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf-8");
const SB_URL = /NEXT_PUBLIC_SUPABASE_URL=(\S+)/.exec(env)[1].trim();
const KEY = /SUPABASE_SERVICE_ROLE_KEY=(\S+)/.exec(env)[1].trim();
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function rest(path, opts = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${path} :: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const resolveBathCode = (bathType, staffOnly) =>
  bathType === "全身浴" ? (staffOnly ? "121121" : "121111") : (staffOnly ? "121122" : "121112");

const dowOf = (dateStr) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
};

// ── 架空職員 (看1+介2 × 2 チーム分) ────────────────────────────────────────
const FAKE_STAFF = [
  { name: "湯本 さゆり", furigana: "ゆもと さゆり", role: "看護師",   team: 1 },
  { name: "田村 大輔",   furigana: "たむら だいすけ", role: "介護福祉士", team: 1 },
  { name: "岡田 実咲",   furigana: "おかだ みさき",   role: "ヘルパー",   team: 1 },
  { name: "白石 恵",     furigana: "しらいし めぐみ", role: "准看護師",   team: 2 },
  { name: "三浦 健",     furigana: "みうら たけし",   role: "介護福祉士", team: 2 },
  { name: "上野 由紀",   furigana: "うえの ゆき",     role: "ヘルパー",   team: 2 },
];

// ── 週間パターン定義 (user_number ベース) ──────────────────────────────────
// 1台1日 6〜7 件 (実際の訪問入浴の標準ルート量)。1件 50 分 + 移動 10 分の時間割。
// 1号車: 月木 7 件 + 水 6 件 / 2号車: 火金 7 件 + 水 6 件
const SLOTS = ["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"];
const endOf = (start) => {
  const [h, m] = start.split(":").map(Number);
  const t = h * 60 + m + 50;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};
const route = (team, dows, defs) =>
  defs.map(([no, bath], i) => ({ no, team, dows, start: SLOTS[i], end: endOf(SLOTS[i]), bath: bath ?? "全身浴" }));

const PATTERN_DEFS = [
  // 1号車 月・木 (7件)
  ...route(1, [1, 4], [["OY001"], ["OY002"], ["OY003", "部分浴"], ["OY004"], ["OY009"], ["A001"], ["B001"]]),
  // 1号車 水 (6件)
  ...route(1, [3], [["OY001"], ["OY002"], ["OY009"], ["A001"], ["B001"], ["C001", "部分浴"]]),
  // 2号車 火・金 (7件)
  ...route(2, [2, 5], [["OY005"], ["OY006"], ["OY007"], ["OY008", "部分浴"], ["OY010"], ["D001"], ["E001"]]),
  // 2号車 水 (6件)
  ...route(2, [3], [["OY005"], ["OY007"], ["OY008", "部分浴"], ["OY010"], ["D001"], ["E001"]]),
];

const main = async () => {
  // ── 利用者解決 (訪問介護サンプル OY001-010 + 居宅サンプル A001-E001) ──
  const wantNos = [
    ...Array.from({ length: 10 }, (_, i) => `OY${String(i + 1).padStart(3, "0")}`),
    "A001", "B001", "C001", "D001", "E001",
  ];
  const pool = await rest(`clients?tenant_id=eq.${TENANT}&user_number=in.(${wantNos.join(",")})&select=id,name,user_number`);
  const clientByNo = Object.fromEntries(pool.map((c) => [c.user_number, c]));
  const missing = wantNos.filter((no) => !clientByNo[no]);
  if (missing.length) throw new Error(`架空利用者が不足: ${missing.join(",")} (先に seed_fake_houmonkaigo_clients.mjs / seed_fake_kyotaku_clients.mjs)`);

  // ── 既存割当確認 (無い利用者のみ追加) ──
  const existAssigns = await rest(`client_office_assignments?office_id=eq.${OFFICE.id}&select=client_id`);
  const assignedIds = new Set(existAssigns.map((a) => a.client_id));
  const newAssigns = wantNos
    .filter((no) => !assignedIds.has(clientByNo[no].id))
    .map((no) => ({ tenant_id: TENANT, client_id: clientByNo[no].id, office_id: OFFICE.id, start_date: `${MONTH}-01`, service_notes: ASSIGN_MARKER }));

  // ── 号車 (既存再利用、無ければ作成予定) ──
  const existTeams = await rest(`kaigo_bath_teams?office_id=eq.${OFFICE.id}&select=id,name`);
  const teamPlans = [1, 2].map((n) => {
    const found = existTeams.find((t) => t.name === `${n}号車`);
    return { n, name: `${n}号車`, id: found?.id ?? null };
  });

  // ── 既存の架空職員 (再実行時は再利用) ──
  const existFakeStaff = await rest(`members?qualifications=like.*${encodeURIComponent(MARKER)}*&select=id,name`);

  // ── 稼働日の洗い出し ──
  const daysInJul = 31;
  const teamDows = { 1: [1, 3, 4], 2: [2, 3, 5] }; // 1号車=月水木, 2号車=火水金
  const workDates = { 1: [], 2: [] };
  for (let d = 1; d <= daysInJul; d++) {
    const dateStr = `${MONTH}-${String(d).padStart(2, "0")}`;
    const dow = dowOf(dateStr);
    for (const t of [1, 2]) if (teamDows[t].includes(dow)) workDates[t].push(dateStr);
  }

  // ── 予定コマの展開 ──
  const visitPlans = []; // { teamN, dateStr, def, order }
  for (let d = 1; d <= daysInJul; d++) {
    const dateStr = `${MONTH}-${String(d).padStart(2, "0")}`;
    const dow = dowOf(dateStr);
    for (const t of [1, 2]) {
      const defs = PATTERN_DEFS.filter((p) => p.team === t && p.dows.includes(dow)).sort((a, b) => a.start.localeCompare(b.start));
      defs.forEach((def, i) => visitPlans.push({ teamN: t, dateStr, def, order: i + 1 }));
    }
  }
  const actualPlans = visitPlans.filter((v) => Number(v.dateStr.slice(8)) <= ACTUAL_UNTIL);

  console.log(`事業所: ${OFFICE.name} (${OFFICE.id})`);
  console.log(`利用者 ${wantNos.length} 名: ${wantNos.map((no) => clientByNo[no].name).join("、")}`);
  console.log(`追加割当: ${newAssigns.length}件 (既存 ${assignedIds.size}件)`);
  console.log(`号車: ${teamPlans.map((t) => `${t.name}${t.id ? " (既存)" : " (新規)"}`).join(" / ")}`);
  console.log(`架空職員: ${FAKE_STAFF.length}名 (既存 marker 職員 ${existFakeStaff.length}名は再利用)`);
  console.log(`週間パターン: ${PATTERN_DEFS.length}本`);
  console.log(`予定コマ: ${visitPlans.length}件 (うち 7/1〜7/${ACTUAL_UNTIL} の ${actualPlans.length}件は実績反映済に)`);
  console.log(`当日編成: 1号車 ${workDates[1].length}日 / 2号車 ${workDates[2].length}日 (7/17 の 2号車は看護なし=減算警告デモ)`);

  if (!EXECUTE) {
    console.log("\n[DRY RUN] 実際には投入していません。--execute で本番投入。");
    return;
  }

  // ── 冪等性: marker 分を先に削除 (実績記録 → 予定 → パターン → 編成 → 割当) ──
  await rest(`kaigo_bath_schedule?notes=like.*${encodeURIComponent(MARKER)}*`, { method: "DELETE" });
  await rest(`kaigo_bath_visit_records?notes=like.*${encodeURIComponent(MARKER)}*`, { method: "DELETE" });
  await rest(`kaigo_bath_patterns?notes=like.*${encodeURIComponent(MARKER)}*`, { method: "DELETE" });
  await rest(`kaigo_bath_team_days?notes=like.*${encodeURIComponent(MARKER)}*`, { method: "DELETE" });
  await rest(`client_office_assignments?service_notes=eq.${encodeURIComponent(ASSIGN_MARKER)}`, { method: "DELETE" });

  // ── 職員 (再利用 or 新規) ──
  const staffByName = Object.fromEntries(existFakeStaff.map((s) => [s.name, s]));
  const toCreate = FAKE_STAFF.filter((s) => !staffByName[s.name]);
  if (toCreate.length) {
    const created = await rest("members", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(toCreate.map((s) => ({
        tenant_id: TENANT, name: s.name, furigana: s.furigana, role: s.role,
        qualifications: `${s.role} ${MARKER}`, employment_type: "常勤", hire_date: "2025-04-01", status: "active",
      }))),
    });
    created.forEach((c) => { staffByName[c.name] = c; });
    // member_offices 紐付け (staff ページの自事業所表示用)
    await rest("member_offices", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates" },
      body: JSON.stringify(created.map((c) => ({ member_id: c.id, office_id: OFFICE.id, is_primary: false }))),
    });
    console.log(`[OK] 架空職員 ${created.length}名 INSERT + member_offices 紐付け`);
  }
  const teamStaffIds = {
    1: FAKE_STAFF.filter((s) => s.team === 1).map((s) => staffByName[s.name].id),
    2: FAKE_STAFF.filter((s) => s.team === 2).map((s) => staffByName[s.name].id),
  };
  // 7/17 の 2号車: 看護 (白石) を外して 1号車の介護 (田村) を入れる = 看護なし編成
  const noNurseTeam2 = [staffByName["三浦 健"].id, staffByName["上野 由紀"].id, staffByName["田村 大輔"].id];

  // ── 割当 (marker 削除後に再取得して不足分を入れる。削除前の判定だと再実行時に抜ける) ──
  const existAfterDelete = await rest(`client_office_assignments?office_id=eq.${OFFICE.id}&select=client_id`);
  const haveIds = new Set(existAfterDelete.map((a) => a.client_id));
  const assignRows = wantNos
    .filter((no) => !haveIds.has(clientByNo[no].id))
    .map((no) => ({ tenant_id: TENANT, client_id: clientByNo[no].id, office_id: OFFICE.id, start_date: `${MONTH}-01`, service_notes: ASSIGN_MARKER }));
  if (assignRows.length) {
    const ins = await rest("client_office_assignments", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(assignRows) });
    console.log(`[OK] 利用者割当 ${ins.length}件 INSERT`);
  }

  // ── 号車 ──
  for (const t of teamPlans) {
    if (!t.id) {
      const ins = await rest("kaigo_bath_teams", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify([{ tenant_id: TENANT, office_id: OFFICE.id, name: t.name, sort_order: t.n, vehicle_note: MARKER }]),
      });
      t.id = ins[0].id;
      console.log(`[OK] ${t.name} INSERT`);
    }
  }
  const teamIdOf = { 1: teamPlans[0].id, 2: teamPlans[1].id };

  // ── 週間パターン ──
  const patRows = PATTERN_DEFS.flatMap((p) =>
    p.dows.map((dow) => ({
      tenant_id: TENANT, office_id: OFFICE.id, client_id: clientByNo[p.no].id,
      day_of_week: dow, start_time: p.start, end_time: p.end,
      team_id: teamIdOf[p.team], bath_type: p.bath, scheme: "介護保険", is_active: true,
      notes: MARKER,
    }))
  );
  const insPat = await rest("kaigo_bath_patterns", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(patRows) });
  console.log(`[OK] 週間パターン ${insPat.length}件 INSERT`);

  // ── 当日編成 ──
  // staff_times 列 (bath_shift_v2) の適用確認 (未適用なら兼務デモをスキップ)
  let hasStaffTimes = true;
  try {
    await rest("kaigo_bath_team_days?select=staff_times&limit=1");
  } catch {
    hasStaffTimes = false;
    console.log("[SKIP] staff_times 列が未適用のため兼務デモ (7/16) は入れません (bath_shift_v2_staff_times.sql)");
  }
  const teamDayRows = [];
  for (const t of [1, 2]) {
    for (const dateStr of workDates[t]) {
      const noNurse = t === 2 && dateStr === `${MONTH}-17`;
      // 兼務デモ: 7/16 の 1号車は看護師 (湯本) が午前のみ乗車 → 午後のコマは看護なし減算
      const kenmuDemo = hasStaffTimes && t === 1 && dateStr === `${MONTH}-16`;
      teamDayRows.push({
        tenant_id: TENANT, team_id: teamIdOf[t], work_date: dateStr,
        staff_ids: noNurse ? noNurseTeam2 : teamStaffIds[t],
        ...(hasStaffTimes
          ? { staff_times: kenmuDemo ? { [staffByName["湯本 さゆり"].id]: { start: "09:00", end: "12:00" } } : {} }
          : {}),
        notes: noNurse
          ? `看護師欠勤のため介護 3 名 ${MARKER}`
          : kenmuDemo
          ? `湯本は午後 訪問介護へ (兼務デモ) ${MARKER}`
          : MARKER,
      });
    }
  }
  const insTd = await rest("kaigo_bath_team_days", {
    method: "POST",
    headers: { Prefer: "return=representation,resolution=merge-duplicates" },
    body: JSON.stringify(teamDayRows),
  });
  console.log(`[OK] 当日編成 ${insTd.length}件 UPSERT`);

  // ── 予定コマ ──
  const schedRows = visitPlans.map((v) => ({
    tenant_id: TENANT, office_id: OFFICE.id, client_id: clientByNo[v.def.no].id,
    team_id: teamIdOf[v.teamN], visit_date: v.dateStr,
    start_time: v.def.start, end_time: v.def.end, visit_order: v.order,
    bath_type: v.def.bath, scheme: "介護保険", status: "scheduled", notes: MARKER,
  }));
  const insSched = await rest("kaigo_bath_schedule", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(schedRows) });
  console.log(`[OK] 予定コマ ${insSched.length}件 INSERT`);

  // ── 7/1〜7/14 を実績反映済に (records INSERT → schedule に record_id) ──
  // insSched は投入順を保持するので visitPlans と index が一致する
  const actualIdx = visitPlans.map((v, i) => ({ v, i })).filter(({ v }) => Number(v.dateStr.slice(8)) <= ACTUAL_UNTIL);
  const recRows = actualIdx.map(({ v }) => {
    const noNurse = v.teamN === 2 && v.dateStr === `${MONTH}-17`; // (17>14 なので実際は発生しないが規則として明示)
    const staffOnly = noNurse;
    return {
      client_id: clientByNo[v.def.no].id, office_id: OFFICE.id, tenant_id: TENANT,
      visit_date: v.dateStr, start_time: v.def.start, end_time: v.def.end,
      bath_type: v.def.bath, staff_only: staffOnly, scheme: "介護保険",
      service_code: resolveBathCode(v.def.bath, staffOnly),
      staff_ids: teamStaffIds[v.teamN],
      vital_temperature: 36.3, vital_bp_sys: 124, vital_bp_dia: 74, vital_pulse: 70, vital_spo2: 97, water_temp: 40,
      condition_before: "状態安定。", condition_after: "入浴後、爽快感あり。", skin_notes: "異常なし。",
      notes: `シフトから実績反映 ${MARKER}`, status: "draft",
    };
  });
  const insRec = await rest("kaigo_bath_visit_records", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(recRows) });
  console.log(`[OK] 実績記録 ${insRec.length}件 INSERT`);
  let linked = 0;
  for (let k = 0; k < actualIdx.length; k++) {
    const schedId = insSched[actualIdx[k].i].id;
    await rest(`kaigo_bath_schedule?id=eq.${schedId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "completed", record_id: insRec[k].id }),
    });
    linked++;
  }
  console.log(`[OK] 予定 ${linked}件 を completed + record_id リンク`);

  // ── 件数確認 ──
  const count = async (path) => (await rest(`${path}&select=id`)).length;
  console.log("\n── 投入後の件数確認 ──");
  console.log(`kaigo_bath_teams (事業所内):     ${await count(`kaigo_bath_teams?office_id=eq.${OFFICE.id}`)}`);
  console.log(`kaigo_bath_patterns (marker):    ${await count(`kaigo_bath_patterns?notes=like.*${encodeURIComponent(MARKER)}*`)}`);
  console.log(`kaigo_bath_team_days (marker):   ${await count(`kaigo_bath_team_days?notes=like.*${encodeURIComponent(MARKER)}*`)}`);
  console.log(`kaigo_bath_schedule (marker):    ${await count(`kaigo_bath_schedule?notes=like.*${encodeURIComponent(MARKER)}*`)}`);
  console.log(`  うち completed:                ${await count(`kaigo_bath_schedule?notes=like.*${encodeURIComponent(MARKER)}*&status=eq.completed`)}`);
  console.log(`kaigo_bath_visit_records (marker): ${await count(`kaigo_bath_visit_records?notes=like.*${encodeURIComponent(MARKER)}*`)}`);
};

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
