// ============================================================================
// ほのぼの「サービス担当者会議の要点」PDF を kaigo_report_documents
// (report_type='meeting-minutes') に取り込む (2026-09-14・PDF解析以外を先行実装)
//
// ⚠ このscriptは tsx で実行すること (src/lib/*.ts を直接importするため)
//
//   npx tsx migrations/import_meeting_minutes_from_pdf.mjs --load <json> [--office 四街道]
//   npx tsx migrations/import_meeting_minutes_from_pdf.mjs --load <json> [--office 四街道] --execute
//
// ── ★重要な訂正 (2026-09-14) ─────────────────────────────────────────────
//   当初「既存70件(手入力)のservice_meeting_notesテーブルに合わせる」前提で
//   調査していたが、★/meeting-minutes画面はservice_meeting_notesを一切
//   読んでいない(src/配下でgrepしても参照0件、migrations/merge_duplicate_
//   clients.mjsだけが触っている=データ衛生ツールの対象止まり)。
//   ★画面が実際に読むのは kaigo_report_documents
//   (report_type='meeting-minutes'、content jsonbにMeetingContent型)
//   であり、こちらは現在0行 (src/lib/meeting-minutes/queries.ts・types.ts参照)。
//   ★この取込scriptはservice_meeting_notesではなく★kaigo_report_documentsを
//   対象にする (画面に実際に出る場所へ入れる)。
//
// ── 入力JSONの仮スキーマ (_parse_meeting_record_pdf.py の出力そのまま) ──────
//   { office, print_date, created_date, client_name, creator_name,
//     meeting_date, meeting_place, meeting_time, meeting_count,
//     attendees_raw: string[], discussed_items, remaining_issues,
//     discussion_content, conclusion, source_file }
//
// ── MeetingContentへのマッピング ────────────────────────────────────────
//   meeting_date ← meeting_date / location ← meeting_place /
//   time_range ← meeting_time / session_number ← meeting_count /
//   creator_name ← creator_name / topics ← discussed_items /
//   discussion ← discussion_content / conclusion ← conclusion /
//   remaining_issues ← remaining_issues
//   ⚠ attendees (Attendee[]・{affiliation,name}) は★構造化していない。
//     attendees_rawの行を語間隔だけで所属/氏名に安定分割できなかったため
//     (パーサのコメント参照)。attendeesは空配列のまま入れ、attendees_rawは
//     DRY RUN出力にだけ表示する (要目視確認・手動入力の候補として)。
//   ⚠ self_attended/family_attended/family_relationship/remarks/
//     care_level_snapshot等は★PDFから確実に取れる材料が無いため、
//     取込では書かない (self_attended等はfalse/空のデフォルトのまま)。
//
// ⚠ 利用者の同定は事業所+氏名 (_name_normalize.mjs)。同姓同名・未登録は
//   引き当てず一覧に出す。
// ⚠ 重複防止: (user_id, content.meeting_date) が既にあればスキップ。
// ⚠ care_plan_id: モニタリングと同じ設計 (対象日をカバー→無ければ
//   careplan-selection.tsのselectCurrentPlanWithFallback)。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectCurrentPlanWithFallback } from "../src/lib/careplan-selection.ts";
import { normName } from "./_name_normalize.mjs";

const EXECUTE = process.argv.includes("--execute");
const argAfter = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 || i + 1 >= process.argv.length ? null : process.argv[i + 1];
};
const LOAD_PATH = argAfter("--load");
const OFFICE_NAME = argAfter("--office");
const TENANT = "kt-group";
const REPORT_TYPE = "meeting-minutes";
const ROOT = fileURLToPath(new URL("../", import.meta.url));

const env = {};
for (const l of readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

async function fetchAll(table, select, tweak) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(select).order("id").range(from, from + 999);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) { console.error(`✗ ${table}: ${error.message}`); process.exit(1); }
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

function loadJson(p) {
  if (!existsSync(p)) { console.error(`✗ ${p} が無い`); process.exit(1); }
  const data = JSON.parse(readFileSync(p, "utf8"));
  const list = Array.isArray(data) ? data : [data];
  return list;
}

async function main() {
  if (!LOAD_PATH) {
    console.error("使い方: --load <json> [--office <名前>] [--execute]");
    process.exit(1);
  }
  console.log(`=== 会議録(サービス担当者会議の要点) 取込 ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);
  console.log(`  ★ 保存先は kaigo_report_documents (report_type='${REPORT_TYPE}')`);
  console.log(`    (service_meeting_notesではない。画面 /meeting-minutes が読むのはこちら)\n`);

  const records = loadJson(LOAD_PATH);
  console.log(`  入力 ${records.length} 件`);

  // ── 事業所を絞って clients に引き当てる ──────────────────────────────
  let clients = [];
  if (OFFICE_NAME) {
    const { data: offs, error } = await sb.from("offices")
      .select("id, name").eq("tenant_id", TENANT)
      .eq("service_type", "居宅介護支援").ilike("name", `%${OFFICE_NAME}%`);
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    if (!offs?.length) { console.error(`✗ 居宅事業所「${OFFICE_NAME}」が offices に無い`); process.exit(1); }
    console.log(`  事業所: ${offs.map((o) => o.name).join(" / ")}`);
    const asg = await fetchAll("client_office_assignments", "client_id",
      (q) => q.in("office_id", offs.map((o) => o.id)));
    const ids = [...new Set(asg.map((a) => a.client_id))];
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await sb.from("clients").select("id, name").in("id", ids.slice(i, i + 200));
      clients.push(...(data ?? []));
    }
  } else {
    clients = await fetchAll("clients", "id, name", (q) => q.eq("tenant_id", TENANT));
  }
  const byName = new Map();
  for (const c of clients) {
    const k = normName(c.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(c);
  }

  const problems = [];
  for (const r of records) {
    const hits = byName.get(normName(r.client_name)) ?? [];
    if (hits.length === 1) r.clientId = hits[0].id;
    else problems.push(`${r.client_name}: 当方の利用者が ${hits.length} 名 (${hits.length === 0 ? "未登録" : "同姓同名につき決められない"})`);
  }
  const ok = records.filter((r) => r.clientId);
  console.log(`\n  引き当て ${ok.length} / ${records.length} 名`);
  if (problems.length) {
    console.log(`  -- 引き当てられない ${problems.length} 件 --`);
    for (const p of problems) console.log(`     ${p}`);
  }

  // ── 重複防止: (user_id, content->>meeting_date) が既にあればスキップ ────
  const existingKeys = new Set();
  {
    const ids = ok.map((r) => r.clientId);
    for (let i = 0; i < ids.length; i += 100) {
      const rows = await fetchAll("kaigo_report_documents", "user_id, content",
        (q) => q.eq("report_type", REPORT_TYPE).in("user_id", ids.slice(i, i + 100)));
      for (const row of rows) existingKeys.add(`${row.user_id}|${row.content?.meeting_date ?? ""}`);
    }
  }
  const dup = ok.filter((r) => existingKeys.has(`${r.clientId}|${r.meeting_date}`));
  const fresh = ok.filter((r) => !existingKeys.has(`${r.clientId}|${r.meeting_date}`));
  if (dup.length) {
    console.log(`\n  -- 既に同じ日付の会議録があるためスキップ ${dup.length} 件 --`);
    for (const r of dup) console.log(`     ${r.client_name} (${r.meeting_date})`);
  }

  // ── care_plan_id 解決 (モニタリングと同じ設計) ──────────────────────────
  const plansByUser = new Map();
  {
    const ids = fresh.map((r) => r.clientId);
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await sb.from("kaigo_care_plans")
        .select("id, user_id, status, start_date, end_date").in("user_id", ids.slice(i, i + 100));
      if (error) { console.error(`✗ 計画書の取得に失敗: ${error.message}`); process.exit(1); }
      for (const p of data ?? []) {
        if (!plansByUser.has(p.user_id)) plansByUser.set(p.user_id, []);
        plansByUser.get(p.user_id).push(p);
      }
    }
  }
  function resolveCarePlanId(uid, day) {
    const list = plansByUser.get(uid) ?? [];
    if (!list.length) return null;
    const covering = list.find((p) => (!p.start_date || p.start_date <= day) && (!p.end_date || p.end_date >= day));
    if (covering) return covering.id;
    const sorted = list.slice().sort((a, b) => String(b.start_date ?? "").localeCompare(String(a.start_date ?? "")));
    return selectCurrentPlanWithFallback(sorted)?.id ?? null;
  }

  let noPlan = 0;
  const inserts = [];
  for (const r of fresh) {
    const carePlanId = resolveCarePlanId(r.clientId, r.meeting_date);
    if (!carePlanId) noPlan++;
    const content = {
      meeting_date: r.meeting_date,
      location: r.meeting_place || "",
      time_range: r.meeting_time || "",
      session_number: r.meeting_count || "",
      creator_name: r.creator_name || "",
      attendees: [], // ★構造化していない (下記attendees_rawを参照して人が入力)
      self_attended: false,
      family_attended: false,
      family_relationship: "",
      remarks: "",
      topics: r.discussed_items || "",
      discussion: r.discussion_content || "",
      conclusion: r.conclusion || "",
      remaining_issues: r.remaining_issues || "",
    };
    inserts.push({
      user_id: r.clientId,
      care_plan_id: carePlanId,
      report_type: REPORT_TYPE,
      title: `サービス担当者会議の要点　${r.meeting_date || ""}`.trim(),
      content,
      status: "completed",
      name: r.client_name,
      attendees_raw: r.attendees_raw ?? [],
    });
  }

  console.log(`\n  取込対象 ${inserts.length} 件`);
  if (noPlan) console.log(`  ⚠ care_plan_id が付けられない (計画書が1件も無い) ${noPlan} 件 — null のまま入る`);
  for (const i of inserts) {
    console.log(`     ${i.name}  [${i.content.meeting_date}]  care_plan_id=${i.care_plan_id ?? "(無し)"}`);
    if (i.attendees_raw.length) {
      console.log(`       ⚠ attendees未構造化(要目視確認): ${i.attendees_raw.join(" / ")}`);
    }
  }

  if (!EXECUTE) { console.log("\n※ DRY RUN のため INSERT していません。--execute で反映します。"); return; }

  let n = 0;
  for (const i of inserts) {
    const { error } = await sb.from("kaigo_report_documents").insert({
      user_id: i.user_id,
      care_plan_id: i.care_plan_id,
      report_type: i.report_type,
      title: i.title,
      content: i.content,
      status: i.status,
    });
    if (error) { console.error(`✗ ${i.name}: ${error.message}`); process.exit(1); }
    n++;
  }
  console.log(`\n✓ ${n} 件を取り込みました`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
