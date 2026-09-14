// ============================================================================
// ほのぼのの「モニタリングシート」PDF を kaigo_monitoring_sheets /
// kaigo_monitoring_items に取り込む (2026-09-14・PDF解析以外を先行実装)
//
// ⚠ このscriptは tsx で実行すること (src/lib/*.ts を直接importするため)
//
//   npx tsx migrations/import_monitoring_from_pdf.mjs --load <json> [--office 高品]
//   npx tsx migrations/import_monitoring_from_pdf.mjs --load <json> [--office 高品] --execute
//
// ── まだ無いもの ───────────────────────────────────────────────────────────
//   PDF → JSON のパーサ (_parse_monitoring_pdf.py) はリモートで実物のPDFを
//   見てから作る。--pdf は今はエラーを出すだけのスタブ。パーサができたら
//   parsePdfs() の中身だけ差し替えれば良いように、以降の処理は全部
//   「パーサが出すJSON」を入力に組んである (--load はそのJSONを直接渡す経路)。
//
// ── 入力JSONの仮スキーマ (リモートで実物を見て変わる前提) ───────────────────
//   {
//     "people": [
//       {
//         "name": "高萩 典子",
//         "monitoring_date": "2026-08-15",
//         "assessor_name": "ほのぼの 管理者",
//         "form_type": "要介護",              // "要介護" のみ対応 (予防は未対応。下記)
//         "status": "completed",              // 省略時は "completed" (過去の確定記録の移行のため)
//         "items": [
//           { "item_number": 1, "short_term_goal": "...", "goal_period_start": "2026-06-01",
//             "goal_period_end": "2026-11-30", "service_type": "訪問介護", "provider_name": "...",
//             "implementation_status": "...", "user_satisfaction": "満足", "family_satisfaction": "満足",
//             "satisfaction_comment": "...", "achievement": "ほぼ達成", "adl_change": "不変",
//             "plan_revision_needed": "なし", "revision_reason": "" }
//         ]
//       }
//     ]
//   }
//
// ⚠ 予防様式 (form_type="予防") は未対応。予防はpreventive_content(jsonb)に
//   全く別構造で入るため、PDFの実物 (介護予防支援モニタリング) を見てから
//   別途対応する。予防様式のPDFが混ざっていたら一覧に出して除外する。
//
// ⚠ 利用者の同定は **事業所 + 氏名** (PDFに利用者番号が無い)。
//   同姓同名は引き当てず一覧に出す (import_support_records_from_pdf.mjs と同じ方針)。
// ⚠ 重複防止: (user_id, monitoring_date) が既にあればスキップ (上書きしない。
//   人が直した内容を消さないため — import_assessment_from_pdf.mjs と同じ方針)。
// ⚠ care_plan_id: 対象日 (monitoring_date) をカバーするプランを探し、無ければ
//   careplan-selection.ts の selectCurrentPlanWithFallback (共有ロジック。
//   インラインコピーしない) に寄せる。どちらも無ければ null のまま入れる
//   (画面はcare_plan_idで絞り込むため、null/不一致だと一覧に出ない。
//   SESSION_START の certification_id と同型の罠。呼出側で必ず注意すること)。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectCurrentPlanWithFallback } from "../src/lib/careplan-selection.ts";
import { revisionNeededToDb } from "../src/lib/monitoring-plan-revision.ts";

const EXECUTE = process.argv.includes("--execute");
const argAfter = (name) => {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return null;
  return process.argv[i + 1];
};
const argsAfter = (name) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < process.argv.length && !process.argv[j].startsWith("--"); j++) out.push(process.argv[j]);
  return out;
};
const LOAD_PATH = argAfter("--load");
const PDFS = argsAfter("--pdf");
const OFFICE_NAME = argAfter("--office");
const TENANT = "kt-group";
const ROOT = fileURLToPath(new URL("../", import.meta.url));

const env = {};
for (const l of readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

const normName = (s) => (s ?? "").normalize("NFKC").replace(/[\s　]/g, "");

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

// ── ★ PDF解析はまだ無い。パーサができたらここだけ差し替える ─────────────────
function parsePdfs() {
  console.error("✗ --pdf はまだ未実装です (_parse_monitoring_pdf.py が無い)。");
  console.error("  実物のPDFをリモートで見てから作ります。今は --load <json> を使ってください。");
  process.exit(1);
}

function loadJson(p) {
  if (!existsSync(p)) { console.error(`✗ ${p} が無い`); process.exit(1); }
  const data = JSON.parse(readFileSync(p, "utf8"));
  if (!Array.isArray(data.people)) { console.error("✗ JSON の形式が違う (people 配列が無い)"); process.exit(1); }
  return data.people;
}

async function main() {
  if (PDFS.length) parsePdfs();
  if (!LOAD_PATH) {
    console.error("使い方: --load <json> [--office <名前>] [--execute]");
    process.exit(1);
  }
  console.log(`=== モニタリングシート 取込 ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);

  const people = loadJson(LOAD_PATH);
  console.log(`  入力 ${people.length} 名`);

  // ── 予防様式は未対応。混ざっていたら除外して一覧に出す ────────────────────
  const preventive = people.filter((p) => p.form_type === "予防");
  const target = people.filter((p) => p.form_type !== "予防");
  if (preventive.length) {
    console.log(`\n  -- 予防様式のため未対応・除外 ${preventive.length} 名 --`);
    for (const p of preventive) console.log(`     ${p.name}`);
  }

  // ── 事業所を絞って clients に引き当てる (import_support_records_from_pdf.mjs と同じ) ──
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
  for (const p of target) {
    const hits = byName.get(normName(p.name)) ?? [];
    // ⚠ 同姓同名は引き当てない (未登録も同じ扱い。0件/複数件どちらも一覧に出す)
    if (hits.length === 1) p.clientId = hits[0].id;
    else problems.push(`${p.name}: 当方の利用者が ${hits.length} 名 (${hits.length === 0 ? "未登録" : "同姓同名につき決められない"})`);
  }
  const ok = target.filter((p) => p.clientId);
  console.log(`\n  引き当て ${ok.length} / ${target.length} 名`);
  if (problems.length) {
    console.log(`  -- 引き当てられない ${problems.length} 名 --`);
    for (const q of problems) console.log(`     ${q}`);
  }

  // ── 重複防止: (user_id, monitoring_date) が既にあればスキップ ────────────
  const existingKeys = new Set();
  {
    const ids = ok.map((p) => p.clientId);
    for (let i = 0; i < ids.length; i += 100) {
      const rows = await fetchAll("kaigo_monitoring_sheets", "user_id, monitoring_date",
        (q) => q.in("user_id", ids.slice(i, i + 100)));
      for (const r of rows) existingKeys.add(`${r.user_id}|${r.monitoring_date}`);
    }
  }
  const dup = ok.filter((p) => existingKeys.has(`${p.clientId}|${p.monitoring_date}`));
  const fresh = ok.filter((p) => !existingKeys.has(`${p.clientId}|${p.monitoring_date}`));
  if (dup.length) {
    console.log(`\n  -- 既に同じ日付のシートがあるためスキップ ${dup.length} 名 --`);
    for (const p of dup) console.log(`     ${p.name} (${p.monitoring_date})`);
  }

  // ── care_plan_id 解決: 対象日をカバー → 無ければ共有ロジックにフォールバック ──
  //   ⚠ selectCurrentPlanWithFallback は「start_date 降順で渡す」契約なので、
  //     取得後にソートしてから渡す (careplan-selection.ts のdocコメント参照)。
  const plansByUser = new Map();
  {
    const ids = fresh.map((p) => p.clientId);
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await sb.from("kaigo_care_plans")
        .select("id, user_id, status, start_date, end_date").in("user_id", ids.slice(i, i + 100));
      if (error) { console.error(`✗ 計画書の取得に失敗: ${error.message}`); process.exit(1); }
      for (const r of data ?? []) {
        if (!plansByUser.has(r.user_id)) plansByUser.set(r.user_id, []);
        plansByUser.get(r.user_id).push(r);
      }
    }
  }
  function resolveCarePlanId(uid, day) {
    const list = plansByUser.get(uid) ?? [];
    if (!list.length) return null;
    const covering = list.find((p) =>
      (!p.start_date || p.start_date <= day) && (!p.end_date || p.end_date >= day));
    if (covering) return covering.id;
    const sorted = list.slice().sort((a, b) => String(b.start_date ?? "").localeCompare(String(a.start_date ?? "")));
    return selectCurrentPlanWithFallback(sorted)?.id ?? null;
  }

  let noPlan = 0;
  const inserts = [];
  for (const p of fresh) {
    const carePlanId = resolveCarePlanId(p.clientId, p.monitoring_date);
    if (!carePlanId) noPlan++;
    inserts.push({
      sheet: {
        tenant_id: TENANT,
        user_id: p.clientId,
        monitoring_date: p.monitoring_date,
        assessor_name: p.assessor_name || null,
        status: p.status || "completed",
        form_type: "要介護",
        care_plan_id: carePlanId,
      },
      items: (p.items ?? []).map((it) => ({
        tenant_id: TENANT,
        item_number: it.item_number,
        short_term_goal: it.short_term_goal || null,
        goal_period_start: it.goal_period_start || null,
        goal_period_end: it.goal_period_end || null,
        service_type: it.service_type || null,
        provider_name: it.provider_name || null,
        implementation_status: it.implementation_status || null,
        user_satisfaction: it.user_satisfaction || null,
        family_satisfaction: it.family_satisfaction || null,
        satisfaction_comment: it.satisfaction_comment || null,
        achievement: it.achievement || null,
        adl_change: it.adl_change || null,
        plan_revision_needed: revisionNeededToDb(it.plan_revision_needed ?? ""),
        revision_reason: it.revision_reason || null,
      })),
      name: p.name,
    });
  }

  console.log(`\n  取込対象 ${inserts.length} 名 (項目 ${inserts.reduce((s, i) => s + i.items.length, 0)} 件)`);
  if (noPlan) console.log(`  ⚠ care_plan_id が付けられない (計画書が1件も無い) ${noPlan} 名 — null のまま入る (画面の計画期間タブでは出ない)`);
  for (const i of inserts.slice(0, 10)) {
    console.log(`     ${i.name}  [${i.sheet.monitoring_date}]  care_plan_id=${i.sheet.care_plan_id ?? "(無し)"}  項目${i.items.length}件`);
  }
  if (inserts.length > 10) console.log(`     … 他 ${inserts.length - 10} 名`);

  if (!EXECUTE) { console.log("\n※ DRY RUN のため INSERT していません。--execute で反映します。"); return; }

  let n = 0;
  for (const i of inserts) {
    const { data: sheetRow, error: sheetErr } = await sb.from("kaigo_monitoring_sheets")
      .insert(i.sheet).select("id").single();
    if (sheetErr) { console.error(`✗ ${i.name}: ${sheetErr.message}`); process.exit(1); }
    if (i.items.length) {
      const { error: itemErr } = await sb.from("kaigo_monitoring_items")
        .insert(i.items.map((it) => ({ ...it, monitoring_sheet_id: sheetRow.id })));
      if (itemErr) { console.error(`✗ ${i.name} の項目: ${itemErr.message}`); process.exit(1); }
    }
    n++;
  }
  console.log(`\n✓ ${n} 名ぶんを取り込みました`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
