// ============================================================================
// 居宅サービス計画書 第2表 (care-plan-2) を kaigo_care_plan_services から一括生成
//
// 2026-09-01 監査是正。
//   kaigo_care_plan_services に 14,774 行 (課題 6,070 / 長期短期目標 9,271) 入って
//   いるのに、帳票 (kaigo_report_documents report_type='care-plan-2') は 8 件しか
//   無く、実地指導で第2表を出せない状態だった。中身はあるのに帳票化されていないだけ。
//
//   node migrations/generate_care_plan_2_documents.mjs             # DRY RUN (既定・書込なし)
//   node migrations/generate_care_plan_2_documents.mjs --execute   # 本番 INSERT
//
// 【生成ロジックは画面と完全に同じにする】
//   reports-content.tsx の `case "care-plan-2"` をそのまま移植している。
//   ここがズレると「script で作った帳票を画面で開くと中身が変わる」ことになるので、
//   fmtReiwa / period / svcRow / 入れ子の組み立て方まで一致させること。
//
// 【certification_id は必ず入れる】
//   care-plan-2 は cert-linked 帳票 (page.tsx:46)。画面は
//   「最新の認定に紐づく doc」だけを表示するので、certification_id が NULL だと
//   **画面から見えず、開くたびに空の帳票が自動生成される**という既知の事故になる。
//   実際、既存の care-plan-2 8 件は全部 certification_id NULL でこの状態。
//   → 計画期間を含む認定があればそれ、無ければ最新の認定を入れる。
//     認定が 1 件も無い利用者は **生成しない** (見えない帳票を増やさない)。
//
// 【第3表 (週間サービス計画) は作らない】
//   frequency 14,749 行のうち曜日が読めるのは 293 行 (1%)、曜日+時刻が揃うのは 9 行だけ。
//   中身は「毎日 R 8/ 6/ 1～R 8/11/30」「適宜 …」がほとんどで、週間の升目に落とせない。
//   無理に作ると「実態と違う週間計画」が 2,500 件できて、そちらのほうが問題になる。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const TENANT = "kt-group";
const KAIGO = fileURLToPath(new URL("../", import.meta.url));

function loadEnv() {
  const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8");
  const e = {};
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return e;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const PAGE = 1000;
async function fetchAll(table, select, tweak) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(table).select(select).order("id").range(from, from + PAGE - 1);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} の取得に失敗: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return out;
  }
}

// ── 画面 (reports-content.tsx:122) と同一の実装 ──
function fmtReiwa(d) {
  if (!d) return "　　年　月　日";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  if (!m) return String(d);
  const y = Number(m[1]), mo = Number(m[2]), day = Number(m[3]);
  if (y >= 2019) return `令和${y - 2018}年${mo}月${day}日`;
  if (y >= 1989) return `平成${y - 1988}年${mo}月${day}日`;
  return `${y}年${mo}月${day}日`;
}

/** reports-content.tsx の case "care-plan-2" をそのまま移植 */
function buildContent(userName, plan, services) {
  const planPeriod = plan ? `${fmtReiwa(plan.start_date)}〜${fmtReiwa(plan.end_date)}` : "";
  const period = (a, b) => (a || b ? `${fmtReiwa(a ?? null)}〜${fmtReiwa(b ?? null)}` : planPeriod);
  const svcRow = (sv) => ({
    content: sv.service_content,
    insurance_flag: "○",
    type: sv.service_type,
    provider: sv.provider ?? "",
    frequency: sv.frequency ?? "",
    period: period(sv.service_start, sv.service_end),
  });

  const ordered = [...services].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
  const hasNesting = ordered.some((sv) => sv.needs || sv.long_term_goal || sv.short_term_goal);

  const today = new Date().toISOString().slice(0, 10);
  if (hasNesting) {
    const blocks = [];
    for (const sv of ordered) {
      const needs = sv.needs ?? "";
      const lg = sv.long_term_goal ?? "";
      const lp = period(sv.long_term_start, sv.long_term_end);
      let block = blocks.find((b) => b.needs === needs && b.long_term_goal === lg);
      if (!block) {
        block = { needs, long_term_goal: lg, long_term_period: lp, goals: [] };
        blocks.push(block);
      }
      const sg = sv.short_term_goal ?? "";
      const sp = period(sv.short_term_start, sv.short_term_end);
      let goal = block.goals.find((g) => g.short_term_goal === sg);
      if (!goal) {
        goal = { short_term_goal: sg, short_term_period: sp, services: [] };
        block.goals.push(goal);
      }
      goal.services.push(svcRow(sv));
    }
    return { user_name: userName, creation_date: fmtReiwa(plan?.start_date ?? today), blocks };
  }
  return {
    user_name: userName,
    creation_date: fmtReiwa(plan?.start_date ?? today),
    blocks: [
      {
        needs: plan?.long_term_goals ?? "",
        long_term_goal: plan?.long_term_goals ?? "",
        long_term_period: planPeriod,
        goals: [
          {
            short_term_goal: plan?.short_term_goals ?? "",
            short_term_period: planPeriod,
            services: ordered.map(svcRow),
          },
        ],
      },
    ],
  };
}

/** 計画期間を含む認定 → 無ければ最新の認定 (画面は最新の認定の doc しか出さない) */
function pickCert(certs, planStart) {
  if (!certs || certs.length === 0) return null;
  const sorted = [...certs].sort((a, b) =>
    String(b.certification_start_date ?? "").localeCompare(String(a.certification_start_date ?? "")),
  );
  if (planStart) {
    const hit = sorted.find(
      (c) =>
        (!c.certification_start_date || c.certification_start_date <= planStart) &&
        (!c.certification_end_date || c.certification_end_date >= planStart),
    );
    if (hit) return hit;
  }
  return sorted[0];
}

async function main() {
  console.log(`=== 第2表 一括生成 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const [plans, services, docs, certs, clients] = await Promise.all([
    fetchAll("kaigo_care_plans", "id, user_id, start_date, end_date, long_term_goals, short_term_goals"),
    fetchAll(
      "kaigo_care_plan_services",
      "id, care_plan_id, service_content, service_type, provider, frequency, service_start, service_end, " +
        "needs, long_term_goal, long_term_start, long_term_end, short_term_goal, short_term_start, short_term_end, display_order",
    ),
    fetchAll("kaigo_report_documents", "id, user_id, report_type, care_plan_id", (q) =>
      q.eq("report_type", "care-plan-2"),
    ),
    fetchAll("client_insurance_records", "id, client_id, certification_start_date, certification_end_date"),
    fetchAll("clients", "id, name"),
  ]);

  const nameById = new Map(clients.map((c) => [c.id, c.name]));
  const svcByPlan = new Map();
  for (const s of services) {
    if (!s.care_plan_id) continue;
    if (!svcByPlan.has(s.care_plan_id)) svcByPlan.set(s.care_plan_id, []);
    svcByPlan.get(s.care_plan_id).push(s);
  }
  const certByClient = new Map();
  for (const c of certs) {
    if (!certByClient.has(c.client_id)) certByClient.set(c.client_id, []);
    certByClient.get(c.client_id).push(c);
  }
  // 既に第2表がある計画 (care_plan_id 紐付きのみ判定できる)
  const donePlan = new Set(docs.filter((d) => d.care_plan_id).map((d) => d.care_plan_id));
  const doneUserNoPlan = new Set(docs.filter((d) => !d.care_plan_id).map((d) => d.user_id));

  const payloads = [];
  let skipNoSvc = 0, skipDone = 0, skipNoCert = 0, skipNoName = 0;

  for (const plan of plans) {
    const svcs = svcByPlan.get(plan.id);
    if (!svcs || svcs.length === 0) { skipNoSvc += 1; continue; }
    if (donePlan.has(plan.id)) { skipDone += 1; continue; }
    // care_plan_id が無い既存 doc を持つ利用者は、二重に作らないよう避ける
    if (doneUserNoPlan.has(plan.user_id)) { skipDone += 1; continue; }
    const name = nameById.get(plan.user_id);
    if (!name) { skipNoName += 1; continue; }
    const cert = pickCert(certByClient.get(plan.user_id), plan.start_date);
    if (!cert) { skipNoCert += 1; continue; }

    payloads.push({
      tenant_id: TENANT,
      user_id: plan.user_id,
      report_type: "care-plan-2",
      title: `居宅サービス計画書（第2表）　${(plan.start_date ?? "").replace(/-/g, "/")}`,
      care_plan_id: plan.id,
      certification_id: cert.id,
      content: buildContent(name, plan, svcs),
      status: "completed",
    });
  }

  console.log(`  計画 ${plans.length} 件 / サービス行 ${services.length} 行`);
  console.log(`  生成対象                 ${payloads.length}`);
  console.log(`  skip: サービス行なし     ${skipNoSvc}`);
  console.log(`  skip: 既に第2表あり      ${skipDone}`);
  console.log(`  skip: 認定が 1 件も無い  ${skipNoCert}  ← 作っても画面に出ないので作らない`);
  console.log(`  skip: 利用者が見つからない ${skipNoName}`);

  if (payloads.length > 0) {
    const s = payloads[0];
    console.log(`\n  サンプル: ${nameById.get(s.user_id)} / ${s.title}`);
    console.log(`    ブロック数 ${s.content.blocks.length} / 先頭の課題: ${String(s.content.blocks[0].needs).slice(0, 40)}`);
  }

  if (!EXECUTE) {
    console.log("\n※ DRY RUN。--execute で INSERT します。");
    return;
  }

  let done = 0;
  for (let i = 0; i < payloads.length; i += 200) {
    const chunk = payloads.slice(i, i + 200);
    const { error } = await sb.from("kaigo_report_documents").insert(chunk);
    if (error) {
      console.error(`✗ INSERT 失敗 (${done} 件済): ${error.message}`);
      process.exit(1);
    }
    done += chunk.length;
    console.log(`  ... ${done}/${payloads.length}`);
  }
  console.log(`\n✓ 第2表を ${done} 件 生成しました。`);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
