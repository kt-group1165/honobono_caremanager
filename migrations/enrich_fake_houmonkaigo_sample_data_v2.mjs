/**
 * 訪問介護 fake サンプル利用者 10 名 (OY001-OY010) の欠けているデータを追加補強する。
 *
 * 対象 clients:
 *   tenant_id='kt-group', user_number LIKE 'OY%'
 *   primary office = Ｈａｎａヘルパーステーションおゆみ野 (id=4f14d50c-76b5-4f44-ac41-ed6d01f53a30)
 *   junction 経由で 居宅支援センターおゆみ野 (id=1b22d425-2ec4-4c2f-a002-c1c994e94507) にも紐付き済
 *
 * 補強内容:
 *   ① kaigo_visit_records: 0 件 → 各 6 件 (過去 30 日、週 2 回想定、身体介護と生活援助を交互)
 *   ② kaigo_support_records: OY010 除く 9 名 → 各 4 件 (支援経過、居宅ケアマネ視点)
 *   ③ client_memos: 全員 0 → 各 1 件
 *   ④ clients.care_manager_id: 全員 null → 新規 care_managers (居宅) に紐付け
 *
 * marker:
 *   notes / body / content 末尾に "[fake テスト用-houmon-enrich2]"
 *
 * Usage:
 *   node migrations/enrich_fake_houmonkaigo_sample_data_v2.mjs              # DRY RUN
 *   node migrations/enrich_fake_houmonkaigo_sample_data_v2.mjs --execute    # 本番
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(path) {
  try {
    const env = readFileSync(path, "utf8");
    const vars = {};
    for (const line of env.split("\n")) {
      const m = line.match(/^([^=]+)=(.+)$/);
      if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return vars;
  } catch { return {}; }
}
const envKaigo = loadEnvFile(join(__dirname, "..", ".env.local"));
const envCal = loadEnvFile(join(__dirname, "..", "..", "calendar-app", ".env.local"));
const SB_URL = envKaigo.NEXT_PUBLIC_SUPABASE_URL || envCal.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = envKaigo.SUPABASE_SERVICE_ROLE_KEY || envCal.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error("❌ env 読めず"); process.exit(1); }

const TENANT_ID = "kt-group";
const HOUMON_OFFICE_ID  = "4f14d50c-76b5-4f44-ac41-ed6d01f53a30"; // Ｈａｎａヘルパーステーションおゆみ野 (offices.id)
const KYOTAKU_OFFICE_ID = "1b22d425-2ec4-4c2f-a002-c1c994e94507"; // Ｈａｎａ居宅支援センターおゆみ野 (offices.id)
// care_managers.care_office_id は care_offices table (居宅事業所マスタ) を指す。
// offices.id とは別の UUID: 9ee3e7e7-... が Ｈａｎａ居宅支援センターおゆみ野の care_offices エントリ
const KYOTAKU_CARE_OFFICE_ID = "9ee3e7e7-d87d-4a11-abb6-4eb13632a5b4";
const MARKER = "[fake テスト用-houmon-enrich2]";
const EXECUTE = process.argv.includes("--execute");

// 居宅ケアマネ 3 名 (fake) — 全員 KYOTAKU office 所属で INSERT
// clients を 3 人に分割して割り当てる (OY001-04 / OY05-07 / OY08-10)
const CARE_MANAGER_NAMES = ["久保田 幸恵", "宮川 律子", "藤田 隆"];

// 支援経過テンプレ (居宅ケアマネ視点、CHECK 制約準拠)
const SUPPORT_TEMPLATES = [
  { cat: "モニタリング", content: (n) => `${n}様 ご自宅へモニタリング訪問。ケアプランの実施状況を確認。本人・家族より現サービスへの満足の声あり。訪問介護 (Hana おゆみ野) の身体介護・生活援助ともに継続の意向を確認。` },
  { cat: "電話", content: (n) => `Hana おゆみ野ヘルパーステーションのサ責と電話連絡。${n}様の訪問時の状況について情報共有。最近やや意欲低下の場面あるとの報告あり。次回モニタリング時に本人と直接話す方針。` },
  { cat: "サービス担当者会議", content: (n) => `${n}様 サービス担当者会議をご自宅にて開催。本人、家族 (長男)、訪問介護サ責、訪問看護師、担当ケアマネ参加。ケアプラン (案) を共有し、週2回の訪問介護継続で合意。次回は3ヶ月後。` },
  { cat: "訪問", content: (n) => `${n}様 ご自宅を訪問し、ご家族と面談。最近の様子について情報共有。デイサービス導入の可能性について検討開始。次回訪問時に本人の意向を確認予定。` },
];

// メモテンプレ (client_memos 用、担当情報を書く)
function makeMemoBody(client, cmName) {
  return `${MARKER} 担当ケアマネ: ${cmName} / user_no: ${client.user_number} / 訪問介護 fake 利用者 / 週2回訪問 (身体介護+生活援助)`;
}

const TODAY = new Date();
function addDays(d, n) { const c = new Date(d); c.setDate(c.getDate() + n); return c; }
function ymd(d) { return d.toISOString().slice(0, 10); }

async function main() {
  console.log(`\n📂 訪問介護 fake 利用者 (OY001-010) の欠けデータ補強 v2`);
  console.log(`🏪 houmon office = ${HOUMON_OFFICE_ID}`);
  console.log(`🏪 kyotaku office = ${KYOTAKU_OFFICE_ID} (ケアマネ所属)`);
  console.log(EXECUTE ? "⚠️  EXECUTE MODE" : "🔍 DRY RUN");
  console.log("");

  const sb = createClient(SB_URL, SB_KEY);

  // ── 対象 clients 取得 ──
  const { data: clients, error: cliErr } = await sb
    .from("clients")
    .select("id, user_number, name, care_manager_id")
    .eq("tenant_id", TENANT_ID)
    .like("user_number", "OY%")
    .order("user_number");
  if (cliErr) { console.error("❌ clients:", cliErr.message); process.exit(1); }
  if (!clients || clients.length === 0) { console.warn("⚠️  OY% clients 0 件"); return; }
  console.log(`👤 対象 clients = ${clients.length} 名`);
  const clientIds = clients.map((c) => c.id);

  // ── 既存 care_managers 探索 (fake 名で先に INSERT 済かも) ──
  const { data: existingCms } = await sb
    .from("care_managers")
    .select("id, name, care_office_id, active")
    .eq("tenant_id", TENANT_ID)
    .in("name", CARE_MANAGER_NAMES);
  const cmByName = new Map();
  for (const cm of existingCms ?? []) {
    // KYOTAKU_OFFICE に紐付いてる active row を優先
    if (cm.care_office_id === KYOTAKU_CARE_OFFICE_ID && cm.active) {
      cmByName.set(cm.name, cm.id);
    } else if (!cmByName.has(cm.name)) {
      cmByName.set(cm.name, cm.id);
    }
  }
  const missingCm = CARE_MANAGER_NAMES.filter((n) => !cmByName.has(n));
  console.log(`\n📋 care_managers 状況:`);
  for (const n of CARE_MANAGER_NAMES) {
    console.log(`   ${n}: ${cmByName.get(n) ?? "(要新規 INSERT)"}`);
  }

  // ── 既存 child row 確認 (idempotent) ──
  const [
    vrExisting,
    supExisting,
    memoExisting,
  ] = await Promise.all([
    (async () => {
      const { data } = await sb.from("kaigo_visit_records").select("user_id").in("user_id", clientIds);
      return data ?? [];
    })(),
    (async () => {
      const { data } = await sb.from("kaigo_support_records").select("user_id").in("user_id", clientIds);
      return data ?? [];
    })(),
    (async () => {
      const { data } = await sb.from("client_memos").select("client_id").in("client_id", clientIds);
      return data ?? [];
    })(),
  ]);
  const vrByClient = new Map();
  for (const r of vrExisting) vrByClient.set(r.user_id, (vrByClient.get(r.user_id) ?? 0) + 1);
  const supByClient = new Map();
  for (const r of supExisting) supByClient.set(r.user_id, (supByClient.get(r.user_id) ?? 0) + 1);
  const memoSet = new Set(memoExisting.map((r) => r.client_id));

  // ── plan 集計 ──
  const cmNeeded = missingCm.length;
  const cmAssign = clients.filter((c) => !c.care_manager_id).length; // 現状 全員 null 想定
  const vrPerClient = 6;
  const vrNeeded = clients
    .filter((c) => (vrByClient.get(c.id) ?? 0) === 0)
    .length * vrPerClient;
  const supPerClient = 4;
  const supNeeded = clients
    .filter((c) => (supByClient.get(c.id) ?? 0) === 0)
    .length * supPerClient;
  const memoNeeded = clients.filter((c) => !memoSet.has(c.id)).length; // × 1

  console.log(`\n📊 生成 plan:`);
  console.log(`   care_managers INSERT (fake 3 名):        ${cmNeeded}`);
  console.log(`   clients.care_manager_id UPDATE:          ${cmAssign}`);
  console.log(`   kaigo_visit_records INSERT (各 ${vrPerClient} 件):    ${vrNeeded}  ※既存 ${vrExisting.length} 件`);
  console.log(`   kaigo_support_records INSERT (各 ${supPerClient} 件): ${supNeeded}  ※既存 ${supExisting.length} 件`);
  console.log(`   client_memos INSERT (各 1 件):           ${memoNeeded}`);
  const total = cmNeeded + cmAssign + vrNeeded + supNeeded + memoNeeded;
  console.log(`   合計:                                    ${total}`);

  if (!EXECUTE) {
    console.log(`\n🔍 DRY RUN 終了。--execute で本番実行。`);
    return;
  }

  // ─────────────────────────────────────────
  // 実書込
  // ─────────────────────────────────────────
  console.log("\n🚀 INSERT/UPDATE 開始...\n");

  // ─── ① 不足 care_managers INSERT ──────────
  let cmIn = 0, cmFail = 0;
  for (const n of missingCm) {
    const { data, error } = await sb.from("care_managers").insert({
      tenant_id: TENANT_ID,
      care_office_id: KYOTAKU_CARE_OFFICE_ID,
      name: n,
      active: true,
    }).select("id").single();
    if (error) { cmFail++; console.warn(`  ✗ care_managers "${n}": ${error.message}`); }
    else { cmByName.set(n, data.id); cmIn++; console.log(`  ✓ care_managers INSERT: ${n} → ${data.id}`); }
  }

  // ─── ② clients.care_manager_id UPDATE ──────
  // 10 名を 3 分割: idx 0-3 → cm[0], 4-6 → cm[1], 7-9 → cm[2]
  function pickCmName(idx) {
    if (idx <= 3) return CARE_MANAGER_NAMES[0];
    if (idx <= 6) return CARE_MANAGER_NAMES[1];
    return CARE_MANAGER_NAMES[2];
  }
  let cmUpd = 0, cmUpdFail = 0;
  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    if (c.care_manager_id) continue; // 既に set 済ならスキップ
    const cmName = pickCmName(i);
    const cmId = cmByName.get(cmName);
    if (!cmId) { cmUpdFail++; console.warn(`  ✗ ${c.user_number}: care_manager "${cmName}" 未解決`); continue; }
    const { error } = await sb.from("clients").update({
      care_manager_id: cmId,
      care_manager: cmName,
    }).eq("id", c.id);
    if (error) { cmUpdFail++; console.warn(`  ✗ ${c.user_number} care_manager_id UPDATE: ${error.message}`); }
    else cmUpd++;
  }

  // ─── ③ kaigo_visit_records INSERT (6 件 / client) ──────
  // 過去 30 日、週 2 回、身体介護 → 生活援助 → 身体介護 → ... 交互
  let vrIn = 0, vrFail = 0;
  const visitPattern = [
    { st: "身体介護",  start: "10:00:00", end: "11:00:00" },
    { st: "生活援助",  start: "14:00:00", end: "15:30:00" },
  ];
  for (const c of clients) {
    if ((vrByClient.get(c.id) ?? 0) > 0) continue; // 既に有るならスキップ
    const rows = [];
    for (let i = 0; i < 6; i++) {
      const d = addDays(TODAY, -(3 + i * 4)); // 3, 7, 11, 15, 19, 23 日前
      const p = visitPattern[i % 2];
      rows.push({
        user_id: c.id,
        // tenant_id は trigger で埋まる (clients.tenant_id から補完)
        visit_date: ymd(d),
        service_type: p.st,
        start_time: p.start,
        end_time: p.end,
        status: "draft",
        notes: `${MARKER} ${p.st}の訪問記録`,
        user_condition: "普段通り。バイタル安定。",
        vital_temperature: Number((36.2 + Math.random() * 0.8).toFixed(1)),
        vital_bp_sys: 120 + Math.floor(Math.random() * 30),
        vital_bp_dia: 70 + Math.floor(Math.random() * 15),
        vital_pulse: 65 + Math.floor(Math.random() * 20),
        vital_spo2: 95 + Math.floor(Math.random() * 4),
      });
    }
    const { error } = await sb.from("kaigo_visit_records").insert(rows);
    if (error) { vrFail++; console.warn(`  ✗ ${c.user_number} visit_records: ${error.message}`); }
    else vrIn += rows.length;
  }

  // ─── ④ kaigo_support_records INSERT (4 件 / client, OY010 除く) ──────
  let sIn = 0, sFail = 0;
  for (const c of clients) {
    const existing = supByClient.get(c.id) ?? 0;
    if (existing > 0) continue; // 既に有るならスキップ
    const rows = [];
    for (let i = 0; i < SUPPORT_TEMPLATES.length; i++) {
      const d = addDays(TODAY, -(10 + i * 18)); // 10, 28, 46, 64 日前
      const tpl = SUPPORT_TEMPLATES[i];
      rows.push({
        user_id: c.id,
        // tenant_id は trigger 補完前提
        tenant_id: TENANT_ID,
        record_date: ymd(d),
        record_time: `${10 + (i % 6)}:${i % 2 === 0 ? "00" : "30"}:00`,
        category: tpl.cat,
        content: `${tpl.content(c.name)} ${MARKER}`,
        staff_name: "担当ケアマネ (fake)",
      });
    }
    const { error } = await sb.from("kaigo_support_records").insert(rows);
    if (error) { sFail++; console.warn(`  ✗ ${c.user_number} support_records: ${error.message}`); }
    else sIn += rows.length;
  }

  // ─── ⑤ client_memos INSERT (1 件 / client) ──────
  let mIn = 0, mFail = 0;
  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    if (memoSet.has(c.id)) continue;
    const cmName = pickCmName(i);
    const { error } = await sb.from("client_memos").insert({
      client_id: c.id,
      scope: "tenant",
      tenant_id: TENANT_ID,
      body: makeMemoBody(c, cmName),
      pinned: false,
    });
    if (error) { mFail++; console.warn(`  ✗ ${c.user_number} client_memos: ${error.message}`); }
    else mIn++;
  }

  console.log(`\n📊 実行結果:`);
  console.log(`   care_managers INSERT:               ${cmIn} 成功 / ${cmFail} 失敗`);
  console.log(`   clients.care_manager_id UPDATE:     ${cmUpd} / ${cmUpdFail}`);
  console.log(`   kaigo_visit_records INSERT:         ${vrIn} / ${vrFail}`);
  console.log(`   kaigo_support_records INSERT:       ${sIn} / ${sFail}`);
  console.log(`   client_memos INSERT:                ${mIn} / ${mFail}`);
  console.log(`\n✅ 完了`);
}

main().catch((e) => { console.error("💥", e); process.exit(1); });
