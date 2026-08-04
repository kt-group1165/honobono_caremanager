/**
 * 相田 絹子 のケアプランを「1件 = 認定有効期間まるごと」から、
 * 節目 (初回 / サービス追加 / 区分変更 / 更新) ごとの 4 世代に再構成する。
 *
 * 現状:
 *   kaigo_care_plans 1 件 (2024-02-01 〜 2028-01-31, active)
 *   └ kaigo_report_documents 4 件が紐付き
 *
 * 実施後:
 *   第1世代 2024-02-01 〜 2024-11-30  初回            completed  (新規)
 *   第2世代 2024-12-01 〜 2025-08-31  サービス追加     completed  (新規)
 *   第3世代 2025-09-01 〜 2026-06-30  区分変更        completed  (新規)
 *   第4世代 2026-07-01 〜 2028-01-31  更新・目標見直し active     (既存行を UPDATE)
 *   ※ 既存行を残して期間だけ現行世代に狭めるので、紐付く帳票 4 件は付け替え不要。
 *
 * --with-insurance を付けた場合のみ (任意):
 *   第3世代の「区分変更」に整合させ、client_insurance_records を 2 件に分割する。
 *     新規  2024-02-01 〜 2025-08-31  要介護2 (限度額 19705)
 *     既存  2025-09-01 〜 2028-01-31  要介護3 (限度額 27048)  ← certification_start_date を UPDATE
 *     clients.certification_start_date も 2025-09-01 に合わせる (care_level は要介護3のまま)
 *   ※ 相田絹子は実績・請求データが 0 件のため副作用なし。付けなければ認定情報は一切触らない。
 *
 * Usage:
 *   node migrations/seed_aida_kinuko_care_plan_generations.mjs                        # DRY RUN
 *   node migrations/seed_aida_kinuko_care_plan_generations.mjs --execute               # ケアプランのみ
 *   node migrations/seed_aida_kinuko_care_plan_generations.mjs --execute --with-insurance
 *
 * 冪等性: 本スクリプトが作った世代 (plan_type が下記定義と一致する行) は再実行時に削除して作り直す。
 *         定義外の plan_type が増えていた場合は手作業の可能性があるため中断する。
 *         元からある行 (created_at 最古 = 帳票が紐付く行) は必ず UPDATE で流用し、削除しない。
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const EXECUTE = process.argv.includes("--execute");
const WITH_INSURANCE = process.argv.includes("--with-insurance");

function loadEnvFile(path) {
  try {
    const vars = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^([^=]+)=(.+)$/);
      if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return vars;
  } catch { return {}; }
}
const env = loadEnvFile(join(__dirname, "..", ".env.local"));
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("❌ SUPABASE URL / SERVICE_ROLE_KEY が読めません (.env.local 確認)");
  process.exit(1);
}
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const CLIENT_ID = "28a1a9f0-24e8-420a-9085-6c7304db95ff"; // 相田 絹子
const TENANT_ID = "kt-group";
const CARE_MANAGER_NUMBER = "12180819";

// ── 世代定義 ───────────────────────────────────────────────
const GENERATIONS = [
  {
    plan_number: 1,
    plan_type: "居宅サービス計画（初回）",
    start_date: "2024-02-01",
    end_date: "2024-11-30",
    status: "completed",
    plan_request_date: "2024-01-25",
    long_term_goals:
      "住み慣れた自宅で、家族の支援を受けながら自分のペースで安全に生活を続けることができる。",
    short_term_goals:
      "①週2回の通所介護で入浴と機能訓練を行い、清潔保持と下肢筋力の維持を図る。\n②手すりを利用して、居室からトイレまでを見守りのもとで自分で移動できる。",
    services: [
      { service_type: "通所介護", service_content: "入浴介助・機能訓練・レクリエーション", frequency: "週2回（火・金） 9:30〜16:00", provider: "デイサービスセンター貝塚" },
      { service_type: "福祉用具貸与", service_content: "手すり（据置型）2点の貸与", frequency: "常時", provider: "千葉ムツミ福祉用具高品" },
    ],
  },
  {
    plan_number: 2,
    plan_type: "居宅サービス計画（サービス追加）",
    start_date: "2024-12-01",
    end_date: "2025-08-31",
    status: "completed",
    plan_request_date: "2024-11-20",
    long_term_goals:
      "同居する長女の就労時間が延びたため、日中独居の時間帯も安心して過ごし、栄養状態と生活リズムを保つことができる。",
    short_term_goals:
      "①訪問介護（生活援助）を週2回追加し、買い物と調理を支援して1日3食を確保する。\n②通所介護を週3回に増やし、入浴と他者との交流の機会を確保する。\n③服薬カレンダーを用いて、飲み忘れなく内服できる。",
    services: [
      { service_type: "通所介護", service_content: "入浴介助・機能訓練・レクリエーション", frequency: "週3回（火・木・金） 9:30〜16:00", provider: "デイサービスセンター貝塚" },
      { service_type: "訪問介護", service_content: "生活援助（買い物・調理・掃除）", frequency: "週2回（月・水） 10:00〜11:00", provider: "ＫＴ訪問介護 若葉" },
      { service_type: "福祉用具貸与", service_content: "手すり（据置型）2点の貸与", frequency: "常時", provider: "千葉ムツミ福祉用具高品" },
    ],
  },
  {
    plan_number: 3,
    plan_type: "居宅サービス計画（区分変更）",
    start_date: "2025-09-01",
    end_date: "2026-06-30",
    status: "completed",
    plan_request_date: "2025-08-22",
    long_term_goals:
      "自宅内での転倒による腰椎圧迫骨折で起居・移乗動作が低下したため区分変更申請（要介護2→要介護3）。安全に起居・移乗ができる環境を整え、再転倒を防ぎながら自宅での生活を継続する。",
    short_term_goals:
      "①特殊寝台・歩行器の貸与により、ベッドからの起き上がりと居室内の移動を安全に行える。\n②訪問看護 週1回で疼痛と服薬の管理を行い、状態悪化を早期に発見する。\n③通所介護での機能訓練を継続し、屋内歩行の耐久性を回復する。",
    services: [
      { service_type: "通所介護", service_content: "入浴介助・機能訓練・レクリエーション", frequency: "週3回（火・木・金） 9:30〜16:00", provider: "デイサービスセンター貝塚" },
      { service_type: "訪問介護", service_content: "身体介護（起床介助・整容）＋生活援助（買い物・調理）", frequency: "週3回（月・水・土） 10:00〜11:00", provider: "ＫＴ訪問介護 若葉" },
      { service_type: "訪問看護", service_content: "健康状態の観察・疼痛管理・服薬管理", frequency: "週1回（木） 13:30〜14:10", provider: "訪問看護ステーション若葉" },
      { service_type: "福祉用具貸与", service_content: "特殊寝台・特殊寝台付属品・歩行器・手すりの貸与", frequency: "常時", provider: "千葉ムツミ福祉用具高品" },
    ],
  },
  {
    // 既存行 (924fa247-...) を UPDATE して現行世代にする
    existing: true,
    plan_number: 4,
    plan_type: "居宅サービス計画（更新・目標見直し）",
    start_date: "2026-07-01",
    end_date: "2028-01-31",
    status: "active",
    long_term_goals:
      "必要な支援を受けながら、住み慣れた自宅で在宅生活を継続する。",
    short_term_goals:
      "①福祉用具を活用して、居室内の移動と排泄を見守りのもとで行える。\n②週3回の通所介護と週3回の訪問介護で、清潔保持・栄養・生活リズムを維持する。\n③訪問看護 週1回で健康管理を継続し、急変時に速やかに対応できる体制を保つ。",
    services: [
      { service_type: "通所介護", service_content: "入浴介助・機能訓練・レクリエーション", frequency: "週3回（火・木・金） 9:30〜16:00", provider: "デイサービスセンター貝塚" },
      { service_type: "訪問介護", service_content: "身体介護（起床介助・整容・排泄介助）＋生活援助", frequency: "週3回（月・水・土） 10:00〜11:00", provider: "ＫＴ訪問介護 若葉" },
      { service_type: "訪問看護", service_content: "健康状態の観察・疼痛管理・服薬管理", frequency: "週1回（木） 13:30〜14:10", provider: "訪問看護ステーション若葉" },
      { service_type: "福祉用具貸与", service_content: "特殊寝台・特殊寝台付属品・車いす・歩行器・手すりの貸与", frequency: "常時", provider: "千葉ムツミ福祉用具高品" },
    ],
  },
];

const die = (msg) => { console.error("❌ " + msg); process.exit(1); };

// ── 事前確認 ───────────────────────────────────────────────
const { data: client, error: cErr } = await sb
  .from("clients").select("id, name, care_level, certification_start_date, certification_end_date")
  .eq("id", CLIENT_ID).single();
if (cErr) die("clients 取得失敗: " + cErr.message);
console.log(`利用者: ${client.name} / ${client.care_level} / 認定 ${client.certification_start_date} 〜 ${client.certification_end_date}`);

const { data: plans, error: pErr } = await sb
  .from("kaigo_care_plans").select("*").eq("user_id", CLIENT_ID)
  .order("created_at", { ascending: true });
if (pErr) die("kaigo_care_plans 取得失敗: " + pErr.message);
console.log(`既存ケアプラン: ${plans.length} 件`);
if (plans.length === 0) die("既存ケアプランが 0 件。想定外なので中断。");

// created_at 最古 = 元からある行 (= 帳票が紐付く行)。これは削除せず UPDATE で流用する。
const basePlan = plans[0];
const KNOWN_TYPES = new Set(GENERATIONS.map((g) => g.plan_type));
const stale = plans.slice(1);
const unknown = stale.filter((p) => !KNOWN_TYPES.has(p.plan_type));
if (unknown.length > 0) {
  die(`本スクリプト由来でないケアプランが ${unknown.length} 件ある (${unknown.map((p) => `${p.id}:${p.plan_type}`).join(", ")})。手作業で作られた可能性があるため中断。`);
}
console.log(`  流用する現行世代: ${basePlan.id} (${basePlan.start_date} 〜 ${basePlan.end_date}, ${basePlan.status})`);
if (stale.length > 0) console.log(`  再実行のため削除する前回投入分: ${stale.length} 件`);

const { data: docs } = await sb
  .from("kaigo_report_documents").select("id, report_type").eq("care_plan_id", basePlan.id);
console.log(`  紐付く帳票: ${docs?.length ?? 0} 件 (付け替え不要 — 現行世代の id を維持するため)`);

const { data: insRecs, error: iErr } = await sb
  .from("client_insurance_records").select("*").eq("client_id", CLIENT_ID)
  .order("certification_start_date");
if (iErr) die("client_insurance_records 取得失敗: " + iErr.message);

// ── 計画表示 ───────────────────────────────────────────────
console.log("\n" + (EXECUTE ? "=== 本番実行 ===" : "=== DRY RUN (書込みなし) ==="));
for (const g of GENERATIONS) {
  console.log(`\n[第${g.plan_number}世代] ${g.plan_type}  ${g.start_date} 〜 ${g.end_date}  status=${g.status}  ${g.existing ? "← 既存行を UPDATE" : "← 新規 INSERT"}`);
  console.log(`  長期目標: ${g.long_term_goals}`);
  console.log(`  短期目標: ${g.short_term_goals.replace(/\n/g, "\n            ")}`);
  console.log(`  サービス行 ${g.services.length} 件:`);
  for (const s of g.services) console.log(`    - ${s.service_type} / ${s.service_content} / ${s.frequency} / ${s.provider}`);
}

if (WITH_INSURANCE) {
  console.log("\n[--with-insurance] 認定記録の分割:");
  console.log(`  現在 ${insRecs.length} 件`);
  if (insRecs.length !== 1) {
    die(`認定記録が ${insRecs.length} 件。1 件を前提とした分割ロジックのため中断。`);
  }
  console.log("  新規 INSERT: 2024-02-01 〜 2025-08-31  要介護2  限度額 19705");
  console.log(`  既存 UPDATE: ${insRecs[0].id}  certification_start_date 2024-02-01 → 2025-09-01 (要介護3 / 限度額 27048 は据置)`);
  console.log("  clients   UPDATE: certification_start_date 2024-02-01 → 2025-09-01 (care_level は要介護3のまま)");
} else {
  console.log("\n[認定記録] 変更なし (--with-insurance を付けると区分変更に合わせて 2 件に分割)");
}

if (!EXECUTE) {
  console.log("\n--execute を付けると実行します。");
  console.log("  認定記録も区分変更に合わせるなら: --execute --with-insurance");
  process.exit(0);
}

// ── 実行 ───────────────────────────────────────────────────
console.log("\n--- 書込み開始 ---");

if (stale.length > 0) {
  const { error } = await sb.from("kaigo_care_plans").delete().in("id", stale.map((p) => p.id));
  if (error) die("前回投入分の削除失敗: " + error.message);
  console.log(`🧹 前回投入分 ${stale.length} 件を削除`);
}

for (const g of GENERATIONS) {
  const row = {
    user_id: CLIENT_ID,
    tenant_id: TENANT_ID,
    plan_number: g.plan_number,
    plan_type: g.plan_type,
    start_date: g.start_date,
    end_date: g.end_date,
    status: g.status,
    long_term_goals: g.long_term_goals,
    short_term_goals: g.short_term_goals,
  };

  let planId;
  if (g.existing) {
    const { error } = await sb.from("kaigo_care_plans").update(row).eq("id", basePlan.id);
    if (error) die(`第${g.plan_number}世代 UPDATE 失敗: ${error.message}`);
    planId = basePlan.id;
    console.log(`✅ 第${g.plan_number}世代 UPDATE: ${planId}`);
  } else {
    const { data, error } = await sb
      .from("kaigo_care_plans")
      .insert({ ...row, plan_request_date: g.plan_request_date, care_manager_number: CARE_MANAGER_NUMBER })
      .select("id").single();
    if (error) die(`第${g.plan_number}世代 INSERT 失敗: ${error.message}`);
    planId = data.id;
    console.log(`✅ 第${g.plan_number}世代 INSERT: ${planId}`);
  }

  const { error: delErr } = await sb.from("kaigo_care_plan_services").delete().eq("care_plan_id", planId);
  if (delErr) die(`サービス行 削除失敗 (plan ${planId}): ${delErr.message}`);

  const svcRows = g.services.map((s) => ({ ...s, care_plan_id: planId, tenant_id: TENANT_ID }));
  const { error: sErr } = await sb.from("kaigo_care_plan_services").insert(svcRows);
  if (sErr) die(`サービス行 INSERT 失敗 (plan ${planId}): ${sErr.message}`);
  console.log(`   └ サービス行 ${svcRows.length} 件 INSERT`);
}

if (WITH_INSURANCE) {
  const cur = insRecs[0];
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest 除外用 (id/created_at/updated_at を落として INSERT)
  const { id: _omit, created_at: _omit2, updated_at: _omit3, ...rest } = cur;
  const { error: insErr } = await sb.from("client_insurance_records").insert({
    ...rest,
    care_level: "要介護2",
    certification_start_date: "2024-02-01",
    certification_end_date: "2025-08-31",
    service_limit_amount: 19705,
    notes: "[居宅STEP1 2026-06 おゆみ野] 区分変更前 (要介護2)",
  });
  if (insErr) die("認定記録 INSERT 失敗: " + insErr.message);
  console.log("✅ 認定記録 INSERT: 2024-02-01 〜 2025-08-31 要介護2");

  const { error: updErr } = await sb.from("client_insurance_records")
    .update({ certification_start_date: "2025-09-01" }).eq("id", cur.id);
  if (updErr) die("認定記録 UPDATE 失敗: " + updErr.message);
  console.log("✅ 認定記録 UPDATE: 既存を 2025-09-01 開始に");

  const { error: clErr } = await sb.from("clients")
    .update({ certification_start_date: "2025-09-01" }).eq("id", CLIENT_ID);
  if (clErr) die("clients UPDATE 失敗: " + clErr.message);
  console.log("✅ clients UPDATE: certification_start_date 2025-09-01");
}

// ── 検証 ───────────────────────────────────────────────────
const { data: after } = await sb
  .from("kaigo_care_plans").select("id, plan_number, plan_type, start_date, end_date, status, kaigo_care_plan_services(id)")
  .eq("user_id", CLIENT_ID).order("start_date");
console.log("\n--- 検証 ---");
for (const p of after ?? []) {
  console.log(`  第${p.plan_number}世代 ${p.plan_type}  ${p.start_date} 〜 ${p.end_date}  ${p.status}  サービス${p.kaigo_care_plan_services.length}件`);
}
const { data: afterDocs } = await sb
  .from("kaigo_report_documents").select("id").eq("care_plan_id", basePlan.id);
console.log(`  現行世代に紐付く帳票: ${afterDocs?.length ?? 0} 件`);
console.log("\n完了。");
