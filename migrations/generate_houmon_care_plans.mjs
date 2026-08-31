// ============================================================================
// 訪問介護計画書 (kaigo_houmon_care_plans) を **実績から** 一括生成
//
// 2026-09-01 監査是正。
//   訪問介護計画は全利用者について作成し説明・同意・交付する義務がある
//   (指定基準第24条)。画面もテーブルも完成しているのにレコードが 0 件だった。
//
//   node migrations/generate_houmon_care_plans.mjs             # DRY RUN (既定・書込なし)
//   node migrations/generate_houmon_care_plans.mjs --execute   # 本番 INSERT
//   MONTH=2026-06 node migrations/generate_houmon_care_plans.mjs
//
// 【元データは居宅計画ではなく「実績」】
//   当初は居宅サービス計画書 (第1表/第2表) から起こそうとしたが、実測すると
//     訪問介護の利用者 2,384 名 / 第2表あり 400 / 第1表あり 451 / アセスメント 22
//     ★取込元が 1 つも無い 1,931 名 (81%)   ← 他社ケアマネの利用者
//   さらに第2表の frequency は「毎日 R 8/ 6/ 1〜」「適宜」がほとんどで、曜日が
//   読めるのは 14,749 行中 293 行 (1%)。**週間サービスが作れない**。
//
//   一方 kaigo_visit_schedule には 2026-06 の確定実績が 36,722 件あり、曜日・
//   時刻・サービス種別・担当者がそろっている。**実態と一致した計画**になるので
//   こちらを元にする。課題・目標・基本方針は居宅計画がある人だけ併せて埋める。
//
// 【対象は 介護保険 + 総合事業 のみ】
//   障害の居宅介護・重度訪問介護は根拠法も様式も別 (居宅介護計画) なので
//   訪問介護計画書には混ぜない。件数は集計に出す。
//
// 【安定枠だけ・推測しない】
//   週間サービスの抽出条件は extract_visit_patterns_from_jisseki.mjs と同じ
//   (その曜日の 6 割以上の日に出ている枠だけ)。閾値は実測で決めている。
//   同意日・説明日・作成者は **空のまま**。実際に説明していない日を script が
//   埋めたら記録の捏造になる。status も draft。
//
// 【マーカー】
//   special_notes に「<対象月>の提供実績から自動生成」と書く。人が確認して
//   完成にするまで下書きであることを画面上も明示する。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const MONTH = process.env.MONTH || "2026-06";
const TENANT = "kt-group";
const STABLE_RATIO = Number(process.env.RATIO ?? "0.6");
/** 訪問介護計画書が扱う制度 (障害は別様式なので入れない) */
const SYSTEMS = new Set(["介護", "総合事業"]);
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
/** ⚠ order を付けないとページ境界で行が抜ける (Postgres は無指定の行順を保証しない) */
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

const str = (v) => (typeof v === "string" ? v : "");
const hhmm = (v) => String(v ?? "").slice(0, 5);
const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]; // index = getUTCDay()

const monthStart = `${MONTH}-01`;
const monthEnd = (() => {
  const [y, m] = MONTH.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
})();

/** 全角数字 → 半角 */
const han = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/**
 * 実績のサービス名 → 計画書の service_kind (VISIT_CARE_SERVICE_KINDS)。
 * 該当が無ければ "" を返し、生の名前は content に残す。
 * ⚠ 勝手に近い区分へ寄せない。身体介護４ / 身体３生活１ 等は enum に無いので "" のまま。
 */
const SERVICE_KINDS = new Set([
  "身体1", "身体2", "身体3",
  "生活2", "生活3",
  "身体1生活1", "身体1生活2", "身体1生活3",
  "身体2生活1", "身体2生活2", "身体2生活3",
  "通院等乗降介助",
]);
function toServiceKind(raw) {
  // 「・夜」「・２人」等の付帯を落としてから判定する
  const base = han(String(raw ?? "")).split(/[・･]/)[0];
  if (/乗降/.test(base)) return "通院等乗降介助";
  let m = /^身体(\d+)生活(\d+)$/.exec(base);
  if (m) {
    const k = `身体${Number(m[1])}生活${Number(m[2])}`;
    return SERVICE_KINDS.has(k) ? k : "";
  }
  m = /^身体介護(\d+)$/.exec(base);
  if (m) {
    const k = `身体${Number(m[1])}`;
    return SERVICE_KINDS.has(k) ? k : "";
  }
  m = /^生活援助(\d+)$/.exec(base);
  if (m) {
    const k = `生活${Number(m[1])}`;
    return SERVICE_KINDS.has(k) ? k : "";
  }
  return "";
}

/** queries.ts の flattenNeedsBlocks と同一 (第2表 → goals[]) */
function flattenNeedsBlocks(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const b of raw) {
    if (!b || typeof b !== "object") continue;
    const needs = str(b.needs);
    const ltGoal = str(b.long_term_goal);
    const ltPeriod = str(b.long_term_period);
    const goals = Array.isArray(b.goals) ? b.goals : [];
    if (goals.length === 0) {
      out.push({ needs, long_term_goal: ltGoal, long_term_period: ltPeriod, short_term_goal: "", short_term_period: "" });
      continue;
    }
    for (const g of goals) {
      const go = g ?? {};
      out.push({
        needs,
        long_term_goal: ltGoal,
        long_term_period: ltPeriod,
        short_term_goal: str(go.short_term_goal),
        short_term_period: str(go.short_term_period),
      });
    }
  }
  return out;
}

async function main() {
  console.log(`=== 訪問介護計画書 一括生成 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===`);
  console.log(`    週間サービスの元 = ${MONTH} の確定実績 (安定率 ${STABLE_RATIO})\n`);

  const [offices, sched, existing, docs, assessments] = await Promise.all([
    fetchAll("offices", "id, name, service_type"),
    fetchAll(
      "kaigo_visit_schedule",
      "id, user_id, office_id, visit_date, start_time, end_time, service_type, system, staff_id_2, staff_id_3",
      (q) => q.gte("visit_date", monthStart).lt("visit_date", monthEnd).eq("status", "completed"),
    ),
    fetchAll("kaigo_houmon_care_plans", "id, user_id, office_id"),
    fetchAll("kaigo_report_documents", "id, user_id, report_type, content, updated_at", (q) =>
      q.in("report_type", ["care-plan-1", "care-plan-2"]),
    ),
    fetchAll("kaigo_assessments", "id, user_id, user_request, family_request, family_situation, assessment_date"),
  ]);

  const hkOffice = new Map(offices.filter((o) => o.service_type === "訪問介護").map((o) => [o.id, o.name]));
  const rows = sched.filter((r) => hkOffice.has(r.office_id) && r.visit_date && r.start_time);
  const inScope = rows.filter((r) => SYSTEMS.has(String(r.system)));
  const shogai = rows.length - inScope.length;
  console.log(`  訪問介護事業所の実績 ${rows.length} 件 (対象 ${inScope.length} / 障害など対象外 ${shogai})`);

  // ── (利用者×事業所×曜日) の実績日数 = 安定判定の分母 ──
  const dowDays = new Map();
  for (const r of inScope) {
    const dow = new Date(`${r.visit_date}T00:00:00Z`).getUTCDay();
    const k = `${r.user_id}|${r.office_id}|${dow}`;
    if (!dowDays.has(k)) dowDays.set(k, new Set());
    dowDays.get(k).add(r.visit_date);
  }

  // ── 枠 (時間で束ねる。重訪の段・「・２人」行を 1 枠にするのと同じ理由) ──
  const slots = new Map();
  for (const r of inScope) {
    const dow = new Date(`${r.visit_date}T00:00:00Z`).getUTCDay();
    const key = `${r.user_id}|${r.office_id}|${dow}|${hhmm(r.start_time)}|${hhmm(r.end_time)}`;
    let s = slots.get(key);
    if (!s) {
      s = {
        user_id: r.user_id,
        office_id: r.office_id,
        dow,
        start: hhmm(r.start_time),
        end: hhmm(r.end_time),
        dates: new Set(),
        services: new Map(),
        multi: false,
      };
      slots.set(key, s);
    }
    s.dates.add(r.visit_date);
    const svc = str(r.service_type);
    s.services.set(svc, (s.services.get(svc) ?? 0) + 1);
    if (r.staff_id_2 || r.staff_id_3 || /[・･]\s*[２2]人/.test(svc)) s.multi = true;
  }

  // ── 安定枠だけ残し、(開始, 終了, サービス) が同じものを days[] にまとめる ──
  const weeklyByPair = new Map();
  let dropUnstable = 0;
  for (const s of slots.values()) {
    const denom = dowDays.get(`${s.user_id}|${s.office_id}|${s.dow}`)?.size ?? 0;
    if (denom === 0) continue;
    if (s.dates.size < Math.max(2, denom * STABLE_RATIO)) {
      dropUnstable += 1;
      continue;
    }
    // 「・２人」行より基本行を代表にする
    const entries = [...s.services.entries()];
    const base = entries.filter(([k]) => !/[・･]\s*[２2]人/.test(k));
    const svc = (base.length > 0 ? base : entries).reduce((a, b) => (b[1] > a[1] ? b : a))[0];

    const pairKey = `${s.user_id}|${s.office_id}`;
    if (!weeklyByPair.has(pairKey)) weeklyByPair.set(pairKey, new Map());
    const rowKey = `${s.start}|${s.end}|${svc}`;
    const m = weeklyByPair.get(pairKey);
    if (!m.has(rowKey)) {
      m.set(rowKey, {
        days: [],
        start_time: s.start,
        end_time: s.end,
        service_kind: toServiceKind(svc),
        content: svc,
        notes: s.multi ? "2人派遣あり" : "",
      });
    }
    const row = m.get(rowKey);
    const dayKey = WEEKDAY_KEYS[s.dow];
    if (!row.days.includes(dayKey)) row.days.push(dayKey);
    if (s.multi) row.notes = "2人派遣あり";
  }
  console.log(`  週間サービスを作れた (利用者×事業所) の組  ${weeklyByPair.size}`);
  console.log(`  skip: 不安定な枠 (隔週・不定期)            ${dropUnstable}`);

  // ── 課題・目標・意向 (ある人だけ) ──
  const latest = (arr, key) => {
    const m = new Map();
    for (const d of arr) {
      const prev = m.get(d[key]);
      if (!prev || String(d.updated_at ?? "") > String(prev.updated_at ?? "")) m.set(d[key], d);
    }
    return m;
  };
  const doc1 = latest(docs.filter((d) => d.report_type === "care-plan-1"), "user_id");
  const doc2 = latest(docs.filter((d) => d.report_type === "care-plan-2"), "user_id");
  const assessMap = new Map();
  for (const a of [...assessments].sort((x, y) =>
    String(y.assessment_date ?? "").localeCompare(String(x.assessment_date ?? "")),
  )) {
    if (!assessMap.has(a.user_id)) assessMap.set(a.user_id, a);
  }

  const done = new Set(existing.map((p) => `${p.user_id}|${p.office_id}`));
  const doneUser = new Set(existing.map((p) => p.user_id));
  const today = new Date().toISOString().slice(0, 10);

  const payloads = [];
  let skipDone = 0;
  const WEEK_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

  for (const [pairKey, rowMap] of weeklyByPair) {
    const [user_id, office_id] = pairKey.split("|");
    if (done.has(pairKey) || doneUser.has(user_id)) {
      skipDone += 1;
      continue;
    }
    const weekly = [...rowMap.values()]
      .map((r) => ({ ...r, days: WEEK_ORDER.filter((d) => r.days.includes(d)) }))
      .sort((a, b) => a.start_time.localeCompare(b.start_time));

    const row = {
      tenant_id: TENANT,
      user_id,
      office_id,
      plan_kind: "初回",
      plan_date: today,
      status: "draft", // 同意・説明が未入力なので必ず下書き
      weekly_services: weekly,
      // ⚠ goals は NOT NULL (既定値なし)。取込元が無い人でも [] を入れる
      goals: [],
      basic_policy: "",
      user_intention: "",
      family_intention: "",
      family_situation: "",
      source_care_plan_doc_id: null,
      special_notes:
        `${MONTH} の提供実績から自動生成した下書きです。` +
        `週間サービスは実績どおりですが、課題・目標・同意日は未入力です。内容を確認して確定してください。`,
    };

    const d1 = doc1.get(user_id);
    if (d1) {
      const policy = str((d1.content ?? {}).overall_policy);
      if (policy) {
        row.basic_policy = policy;
        row.source_care_plan_doc_id = d1.id;
      }
    }
    const d2 = doc2.get(user_id);
    if (d2) {
      const c = d2.content ?? {};
      const goals = flattenNeedsBlocks(Array.isArray(c.needs_blocks) ? c.needs_blocks : c.blocks);
      if (goals.length > 0) {
        row.goals = goals;
        row.source_care_plan_doc_id = row.source_care_plan_doc_id ?? d2.id;
      }
    }
    const as = assessMap.get(user_id);
    if (as) {
      if (as.user_request) row.user_intention = as.user_request;
      if (as.family_request) row.family_intention = as.family_request;
      if (as.family_situation) row.family_situation = as.family_situation;
    }
    payloads.push(row);
  }

  const svcRows = payloads.reduce((n, p) => n + p.weekly_services.length, 0);
  const kindResolved = payloads.reduce(
    (n, p) => n + p.weekly_services.filter((s) => s.service_kind).length,
    0,
  );
  console.log(`\n  ★生成する計画書              ${payloads.length} 件`);
  console.log(`   skip: 既に計画書がある利用者  ${skipDone}`);
  console.log(`   週間サービスの行数            ${svcRows}  (サービス区分が付いた ${kindResolved})`);
  console.log(`   うち 課題・目標が入る         ${payloads.filter((p) => p.goals?.length).length}`);
  console.log(`   うち 基本方針が入る           ${payloads.filter((p) => p.basic_policy).length}`);
  console.log(`   同意日・説明日・作成者        すべて空 (推測で埋めない)`);

  const sample = payloads.find((p) => p.weekly_services.length >= 2);
  if (sample) {
    console.log(`\n  サンプル (${hkOffice.get(sample.office_id)}):`);
    for (const s of sample.weekly_services.slice(0, 5)) {
      console.log(
        `    ${s.days.join("・")}  ${s.start_time}-${s.end_time}  ` +
          `${s.content}${s.service_kind ? ` → ${s.service_kind}` : " → (区分なし)"}`,
      );
    }
  }

  if (!EXECUTE) {
    console.log("\n※ DRY RUN。--execute で INSERT します。");
    return;
  }

  let n = 0;
  for (let i = 0; i < payloads.length; i += 200) {
    const chunk = payloads.slice(i, i + 200);
    const { error } = await sb.from("kaigo_houmon_care_plans").insert(chunk);
    if (error) {
      console.error(`✗ INSERT 失敗 (${n} 件済): ${error.message}`);
      process.exit(1);
    }
    n += chunk.length;
    console.log(`  ... ${n}/${payloads.length}`);
  }
  console.log(`\n✓ 訪問介護計画書を ${n} 件 (下書き) 生成しました。`);
  console.log(`  ⚠ 課題・目標・同意日は空です。画面で確認して「完成」にしてください。`);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
