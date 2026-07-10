/**
 * Ｈａｮｱヘルパーステーションおゆみ野 (= 訪問介護 office) に
 * 動作確認用 fake 利用者 10 名 + 全関連書類を seed する。
 *
 * 対象 office:
 *   訪問介護 office_id = 4f14d50c-76b5-4f44-ac41-ed6d01f53a30 (Ｈａｮｱヘルパーステーションおゆみ野)
 *   担当居宅 office_id = 1b22d425-2ec4-4c2f-a002-c1c994e94507 (Ｈａｮｱ居宅支援センターおゆみ野)
 *
 * 生成データ (1 利用者あたり):
 *   ① clients                    1 行 (基本情報)
 *   ② client_insurance_records   1 行 (介護保険認定)
 *   ③ kaigo_emergency_sheets     1 行 (緊急時情報)
 *   ④ kaigo_family_contacts      2-3 行 (家族連絡先)
 *   ⑤ kaigo_medical_history      1-2 行 (既往歴)
 *   ⑥ kaigo_medical_insurance    1 行 (医療保険)
 *   ⑦ kaigo_assessments          1 行 (アセスメント)
 *   ⑧ kaigo_care_plans           1 行 (ケアプラン)
 *   ⑨ kaigo_adl_records          1 行 (ADL 評価)
 *   ⑩ kaigo_health_records       6 行 (バイタル、過去 30 日内)
 *   ⑪ kaigo_visit_patterns       3 行 (週次パターン)
 *   ⑫ kaigo_visit_records        8 行 (実績、過去 30 日内)
 *   ⑬ kaigo_visit_schedule       6 行 (来週分 予定)
 *   ⑭ kaigo_monitoring_sheets    1 行 (モニタリング)
 *
 * Usage:
 *   node migrations/seed_fake_houmonkaigo_clients.mjs              # DRY RUN (件数のみ)
 *   node migrations/seed_fake_houmonkaigo_clients.mjs --execute    # 本番実行
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

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
  } catch {
    return {};
  }
}
const envKaigo = loadEnvFile(join(__dirname, "..", ".env.local"));
const envCal = loadEnvFile(join(__dirname, "..", "..", "calendar-app", ".env.local"));
const SB_URL =
  envKaigo.NEXT_PUBLIC_SUPABASE_URL || envCal.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY =
  envKaigo.SUPABASE_SERVICE_ROLE_KEY || envCal.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("❌ SUPABASE URL / SERVICE_ROLE_KEY が読めません (.env.local 確認)");
  process.exit(1);
}

const TENANT_ID = "kt-group";
const HELPER_OFFICE_ID = "4f14d50c-76b5-4f44-ac41-ed6d01f53a30";  // 訪問介護
const FAKE_MARKER = "[fake テスト用-houmon]";

const EXECUTE = process.argv.includes("--execute");

// ── 10 名 利用者マスタ (新規 user_number: OY001-OY010) ──
const CLIENTS = [
  { user_no: "OY001", name: "大塚 紀子",   furi: "オオツカ ノリコ",   gender: "女", birth: "1939-03-15", care_level: "要介護2", insured: "0006000001", postal: "264-0029", address: "千葉県千葉市若葉区桜木1-1-1",   phone: "043-200-0001", blood: "A",  ailment: "高血圧" },
  { user_no: "OY002", name: "木村 弘一",   furi: "キムラ コウイチ",   gender: "男", birth: "1941-07-22", care_level: "要介護3", insured: "0006000002", postal: "264-0029", address: "千葉県千葉市若葉区桜木2-2-2",   phone: "043-200-0002", blood: "O",  ailment: "糖尿病" },
  { user_no: "OY003", name: "清水 美智子", furi: "シミズ ミチコ",     gender: "女", birth: "1937-12-08", care_level: "要介護4", insured: "0006000003", postal: "266-0006", address: "千葉県千葉市緑区おゆみ野3-3-3",  phone: "043-200-0003", blood: "B",  ailment: "脳梗塞後遺症" },
  { user_no: "OY004", name: "林 信夫",     furi: "ハヤシ ノブオ",     gender: "男", birth: "1940-05-30", care_level: "要介護1", insured: "0006000004", postal: "266-0006", address: "千葉県千葉市緑区おゆみ野4-4-4",  phone: "043-200-0004", blood: "AB", ailment: "膝関節症" },
  { user_no: "OY005", name: "山下 静枝",   furi: "ヤマシタ シズエ",   gender: "女", birth: "1935-09-14", care_level: "要介護5", insured: "0006000005", postal: "266-0006", address: "千葉県千葉市緑区おゆみ野5-5-5",  phone: "043-200-0005", blood: "A",  ailment: "認知症" },
  { user_no: "OY006", name: "森 隆一",     furi: "モリ リュウイチ",   gender: "男", birth: "1942-11-25", care_level: "要介護2", insured: "0006000006", postal: "266-0006", address: "千葉県千葉市緑区おゆみ野6-6-6",  phone: "043-200-0006", blood: "O",  ailment: "心房細動" },
  { user_no: "OY007", name: "池田 千代美", furi: "イケダ チヨミ",     gender: "女", birth: "1938-04-03", care_level: "要介護3", insured: "0006000007", postal: "266-0007", address: "千葉県千葉市緑区おゆみ野南7-7-7", phone: "043-200-0007", blood: "B",  ailment: "パーキンソン病" },
  { user_no: "OY008", name: "阿部 正一",   furi: "アベ ショウイチ",   gender: "男", birth: "1936-08-17", care_level: "要介護4", insured: "0006000008", postal: "266-0007", address: "千葉県千葉市緑区おゆみ野南8-8-8", phone: "043-200-0008", blood: "A",  ailment: "COPD" },
  { user_no: "OY009", name: "橋本 とき子", furi: "ハシモト トキコ",   gender: "女", birth: "1934-02-26", care_level: "要介護3", insured: "0006000009", postal: "266-0007", address: "千葉県千葉市緑区おゆみ野南9-9-9", phone: "043-200-0009", blood: "AB", ailment: "リウマチ" },
  { user_no: "OY010", name: "後藤 雅樹",   furi: "ゴトウ マサキ",     gender: "男", birth: "1943-06-11", care_level: "要介護1", insured: "0006000010", postal: "266-0007", address: "千葉県千葉市緑区おゆみ野南10-10",  phone: "043-200-0010", blood: "O",  ailment: "腰椎症" },
];

const TODAY = new Date();
function addDays(d, n) { const c = new Date(d); c.setDate(c.getDate() + n); return c; }
function ymd(d) { return d.toISOString().slice(0, 10); }
function rnd(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

const SERVICE_TYPES = ["身体介護", "生活援助", "身体+生活"];
const VISIT_TIME_SLOTS = [
  { s: "09:00", e: "10:00" }, { s: "10:00", e: "11:30" }, { s: "13:00", e: "14:00" },
  { s: "14:30", e: "15:30" }, { s: "15:30", e: "16:30" }, { s: "16:00", e: "17:00" },
];

async function main() {
  console.log(`\n📂 fake 訪問介護 利用者 seed`);
  console.log(`🏢 office = Ｈａｮｱヘルパーステーションおゆみ野`);
  console.log(`🏪 担当居宅 = Ｈａｮｱ居宅支援センターおゆみ野`);
  console.log(EXECUTE ? "⚠️  EXECUTE MODE (実書込)" : "🔍 DRY RUN");
  console.log("");

  const sb = createClient(SB_URL, SB_KEY);

  // ── ヘルパー member_offices からスタッフ取得 (= staff_id 用) ──
  const { data: moRows } = await sb
    .from("member_offices")
    .select("member_id")
    .eq("office_id", HELPER_OFFICE_ID);
  const memberIds = [...new Set((moRows ?? []).map((r) => r.member_id))];
  let helperStaff = [];
  if (memberIds.length > 0) {
    const { data: members } = await sb
      .from("members")
      .select("id, name")
      .in("id", memberIds)
      .eq("status", "active");
    helperStaff = members ?? [];
  }
  console.log(`👥 ヘルパースタッフ candidate = ${helperStaff.length} 名`);

  // 担当ケアマネ事業所 (care_offices) を解決
  const { data: coRow } = await sb
    .from("care_offices")
    .select("id, name")
    .eq("name", "Ｈａｮｱ居宅支援センターおゆみ野")
    .maybeSingle();
  let careOfficeId = coRow?.id ?? null;
  if (!careOfficeId) {
    // name fuzzy
    const { data: coFuzzy } = await sb
      .from("care_offices")
      .select("id, name")
      .ilike("name", "%居宅%おゆみ野%");
    careOfficeId = coFuzzy?.[0]?.id ?? null;
  }
  console.log(`🏥 care_office_id = ${careOfficeId ?? "(なし、name 文字列のみセット)"}`);

  const pickStaff = (seed) => helperStaff.length > 0 ? helperStaff[seed % helperStaff.length].id : null;

  // ── 既存 fake clients が居るかチェック ──
  const userNos = CLIENTS.map((c) => c.user_no);
  const { data: existing } = await sb
    .from("clients")
    .select("user_number")
    .eq("tenant_id", TENANT_ID)
    .in("user_number", userNos);
  const existingNos = new Set((existing ?? []).map((r) => r.user_number));
  const toInsert = CLIENTS.filter((c) => !existingNos.has(c.user_no));
  console.log(`📋 既存 fake clients = ${existingNos.size}、新規 INSERT 対象 = ${toInsert.length}`);

  if (toInsert.length === 0) {
    console.log("✅ 既に全件 seed 済みです");
    return;
  }

  // ─────────────────────────────────────────
  // 集計 plan (dry-run 表示用)
  // ─────────────────────────────────────────
  const plan = {
    clients: toInsert.length,
    client_insurance_records: toInsert.length,
    kaigo_emergency_sheets: toInsert.length,
    kaigo_family_contacts: toInsert.length * 3,
    kaigo_medical_history: toInsert.length * 2,
    kaigo_medical_insurance: toInsert.length,
    kaigo_assessments: toInsert.length,
    kaigo_care_plans: toInsert.length,
    kaigo_adl_records: toInsert.length,
    kaigo_health_records: toInsert.length * 6,
    kaigo_visit_patterns: toInsert.length * 3,
    kaigo_visit_records: toInsert.length * 8,
    kaigo_visit_schedule: toInsert.length * 6,
    kaigo_monitoring_sheets: toInsert.length,
  };
  console.log(`\n📊 生成 plan (1 件 = 1 行):`);
  for (const [k, v] of Object.entries(plan)) console.log(`   ${k.padEnd(28, " ")} ${v}`);
  console.log(`   ${"合計".padEnd(28, " ")} ${Object.values(plan).reduce((a, b) => a + b, 0)}\n`);

  if (!EXECUTE) {
    console.log("🔍 DRY RUN 終了。--execute で本番実行。");
    return;
  }

  // ─────────────────────────────────────────
  // 本番 INSERT
  // ─────────────────────────────────────────
  console.log("🚀 INSERT 開始...");

  const createdClientIds = [];
  for (let idx = 0; idx < toInsert.length; idx++) {
    const c = toInsert[idx];
    const id = randomUUID();
    createdClientIds.push({ id, ...c });

    // ① clients
    await sb.from("clients").insert({
      id, tenant_id: TENANT_ID,
      user_number: c.user_no, name: c.name, furigana: c.furi,
      birth_date: c.birth, gender: c.gender,
      postal_code: c.postal, address: c.address, phone: c.phone,
      blood_type: c.blood,
      insured_number: c.insured,
      insurer_number: "122192",
      care_level: c.care_level,
      certification_start_date: "2025-04-01",
      certification_end_date: "2027-03-31",
      benefit_rate: "9", copay_rate: "1",
      office_id: HELPER_OFFICE_ID,
      care_office_id: careOfficeId,
      care_manager_org: "Ｈａｮｱ居宅支援センターおゆみ野",
      care_manager: "担当ケアマネ (fake)",
      status: "active", is_facility: false, is_provisional: false,
    });

    // ①.5 client_office_assignments junction (= kaigo-app の自事業所 filter で必要)
    await sb.from("client_office_assignments").insert({
      tenant_id: TENANT_ID,
      client_id: id, office_id: HELPER_OFFICE_ID,
      start_date: new Date().toISOString().slice(0, 10),
    });

    // ② client_insurance_records
    await sb.from("client_insurance_records").insert({
      tenant_id: TENANT_ID, client_id: id,
      effective_date: "2025-04-01",
      insured_number: c.insured, insurer_number: "122192",
      birth_date: c.birth, care_level: c.care_level,
      certification_start_date: "2025-04-01",
      certification_end_date: "2027-03-31",
      copay_rate: "1", benefit_rate: "9",
      insurer_name: "千葉市", care_manager_org: "Ｈａｮｱ居宅支援センターおゆみ野",
      notes: `${FAKE_MARKER} 認定情報`,
    });

    // ③ kaigo_emergency_sheets
    await sb.from("kaigo_emergency_sheets").insert({
      user_id: id, tenant_id: TENANT_ID,
      blood_type: c.blood, allergies: "なし",
      doctor_name: "山田 医師", doctor_hospital: "千葉市民病院", doctor_phone: "043-261-5111",
      emergency_contact1_name: `${c.name.split(" ")[0]} 太郎`, emergency_contact1_relation: "息子", emergency_contact1_phone: "090-0000-0001",
      emergency_contact2_name: `${c.name.split(" ")[0]} 花子`, emergency_contact2_relation: "娘",   emergency_contact2_phone: "090-0000-0002",
      medical_history: c.ailment, current_illness: c.ailment,
      care_manager_name: "担当ケアマネ (fake)", care_manager_office: "Ｈａｮｱ居宅支援センターおゆみ野", care_manager_phone: "043-292-9999",
      notes: `${FAKE_MARKER} 緊急時情報`,
    });

    // ④ kaigo_family_contacts × 3
    const familyData = [
      { name: `${c.name.split(" ")[0]} 太郎`, rel: "長男",  phone: "090-0000-0001", key: true,  notes: "キーパーソン、決定権あり" },
      { name: `${c.name.split(" ")[0]} 花子`, rel: "長女",  phone: "090-0000-0002", key: false, notes: "週末に訪問" },
      { name: `${c.name.split(" ")[0]} 次郎`, rel: "次男",  phone: "090-0000-0003", key: false, notes: "遠方在住" },
    ];
    for (const f of familyData) {
      await sb.from("kaigo_family_contacts").insert({
        user_id: id, tenant_id: TENANT_ID,
        name: f.name, relationship: f.rel, phone: f.phone, is_key_person: f.key,
        notes: `${FAKE_MARKER} ${f.notes}`,
      });
    }

    // ⑤ kaigo_medical_history × 2
    const medHis = [
      { disease: c.ailment, status: "治療中", onset: "2023-04-01", hospital: "千葉市民病院" },
      { disease: "高血圧", status: "治療中", onset: "2020-01-01", hospital: "千葉市民病院" },
    ];
    for (const m of medHis) {
      await sb.from("kaigo_medical_history").insert({
        user_id: id, tenant_id: TENANT_ID,
        disease_name: m.disease, status: m.status,
        onset_date: m.onset, hospital: m.hospital, doctor: "山田 医師",
        notes: `${FAKE_MARKER}`,
      });
    }

    // ⑥ kaigo_medical_insurance
    await sb.from("kaigo_medical_insurance").insert({
      user_id: id, tenant_id: TENANT_ID,
      insurance_type: "後期高齢者医療",
      insurer_number: "39122192", insured_number: c.insured.slice(-8),
      start_date: "2024-04-01", end_date: "2027-03-31",
      copay_rate: 1.0,
    });

    // ⑦ kaigo_assessments
    await sb.from("kaigo_assessments").insert({
      user_id: id, tenant_id: TENANT_ID,
      assessment_date: ymd(addDays(TODAY, -30)),
      assessor_name: "担当ケアマネ (fake)",
      family_situation: "同居家族あり",
      housing_type: "戸建て", housing_situation: "持ち家、1階に居室",
      health_condition: c.ailment,
      mobility_status: c.care_level >= "要介護4" ? "車椅子" : "歩行可 (杖使用)",
      eating_status: "自立",
      toileting_status: c.care_level >= "要介護3" ? "一部介助" : "自立",
      bathing_status: "一部介助",
      cognition_status: c.ailment.includes("認知症") ? "中等度低下" : "軽度低下",
      user_request: "自宅で長く暮らしたい",
      family_request: "本人の意向尊重、安全確保",
      overall_summary: `${FAKE_MARKER} ${c.ailment} あり、ADL 一部介助必要`,
      status: "completed",
    });

    // ⑧ kaigo_care_plans
    const carePlanId = randomUUID();
    await sb.from("kaigo_care_plans").insert({
      id: carePlanId,
      user_id: id, tenant_id: TENANT_ID,
      plan_number: 1, plan_type: "居宅サービス計画",
      start_date: ymd(addDays(TODAY, -30)), end_date: ymd(addDays(TODAY, 335)),
      long_term_goals: "自宅で安全に生活を継続できる",
      short_term_goals: "ADL 維持・服薬管理・家族の介護負担軽減",
      status: "active",
    });

    // ⑨ kaigo_adl_records (Barthel 風スコア)
    const baseAdl = c.care_level.includes("要介護5") ? 1 : c.care_level.includes("要介護4") ? 2 : c.care_level.includes("要介護3") ? 3 : c.care_level.includes("要介護2") ? 4 : 5;
    await sb.from("kaigo_adl_records").insert({
      user_id: id, tenant_id: TENANT_ID,
      assessment_date: ymd(addDays(TODAY, -30)),
      eating: baseAdl, transfer: baseAdl, grooming: baseAdl,
      toilet: baseAdl, bathing: Math.max(1, baseAdl - 1),
      mobility: baseAdl, stairs: Math.max(1, baseAdl - 2),
      dressing: baseAdl, bowel: baseAdl, bladder: baseAdl,
      total_score: baseAdl * 9 + Math.max(1, baseAdl - 1) + Math.max(1, baseAdl - 2),
      assessor_name: "担当ヘルパー (fake)",
      notes: `${FAKE_MARKER}`,
    });

    // ⑩ kaigo_health_records × 6 (バイタル、過去 30 日内)
    for (let h = 0; h < 6; h++) {
      const recDate = addDays(TODAY, -(5 + h * 5));
      await sb.from("kaigo_health_records").insert({
        user_id: id, tenant_id: TENANT_ID,
        record_date: ymd(recDate),
        temperature: 36.0 + Math.random() * 1.2,
        blood_pressure_sys: rnd(120, 160),
        blood_pressure_dia: rnd(70, 90),
        pulse: rnd(60, 90),
        spo2: rnd(94, 99),
        notes: `${FAKE_MARKER} バイタル測定`,
        recorder_name: helperStaff[h % Math.max(1, helperStaff.length)]?.name ?? "担当ヘルパー",
      });
    }

    // ⑪ kaigo_visit_patterns × 3 (週次パターン: 月/水/金)
    const patternDays = [1, 3, 5]; // 月,水,金
    for (let p = 0; p < patternDays.length; p++) {
      const slot = VISIT_TIME_SLOTS[(idx + p) % VISIT_TIME_SLOTS.length];
      const stype = SERVICE_TYPES[p % SERVICE_TYPES.length];
      await sb.from("kaigo_visit_patterns").insert({
        user_id: id, tenant_id: TENANT_ID,
        pattern_name: `${["月","火","水","木","金","土","日"][patternDays[p]]}曜 ${stype}`,
        day_of_week: patternDays[p],
        start_time: slot.s + ":00", end_time: slot.e + ":00",
        staff_id: pickStaff(idx + p),
        service_type: stype,
        notes: `${FAKE_MARKER}`,
      });
    }

    // ⑫ kaigo_visit_records × 8 (過去 30 日 実績)
    for (let v = 0; v < 8; v++) {
      const visDate = addDays(TODAY, -(2 + v * 3));
      const slot = VISIT_TIME_SLOTS[v % VISIT_TIME_SLOTS.length];
      const stype = SERVICE_TYPES[v % SERVICE_TYPES.length];
      await sb.from("kaigo_visit_records").insert({
        user_id: id, tenant_id: TENANT_ID,
        visit_date: ymd(visDate),
        staff_id: pickStaff(idx * 7 + v),
        service_type: stype,
        start_time: slot.s + ":00", end_time: slot.e + ":00",
        body_care: stype !== "生活援助" ? { 排泄: true, 入浴: v % 2 === 0, 整容: true } : null,
        living_support: stype !== "身体介護" ? { 掃除: true, 洗濯: v % 2 === 0, 調理: v % 3 === 0 } : null,
        user_condition: "落ち着いている",
        vital_temperature: 36.0 + Math.random() * 0.8,
        vital_bp_sys: rnd(120, 150), vital_bp_dia: rnd(70, 85), vital_pulse: rnd(65, 85), vital_spo2: rnd(95, 99),
        notes: `${FAKE_MARKER} 訪問記録`,
        status: "completed",
      });
    }

    // ⑬ kaigo_visit_schedule × 6 (来週分 予定)
    for (let s = 0; s < 6; s++) {
      const schDate = addDays(TODAY, 1 + s);
      const slot = VISIT_TIME_SLOTS[s % VISIT_TIME_SLOTS.length];
      const stype = SERVICE_TYPES[s % SERVICE_TYPES.length];
      await sb.from("kaigo_visit_schedule").insert({
        user_id: id, tenant_id: TENANT_ID,
        staff_id: pickStaff(idx * 11 + s),
        visit_date: ymd(schDate),
        start_time: slot.s + ":00", end_time: slot.e + ":00",
        service_type: stype,
        status: "scheduled",
        notes: `${FAKE_MARKER} 予定`,
      });
    }

    // ⑭ kaigo_monitoring_sheets
    await sb.from("kaigo_monitoring_sheets").insert({
      user_id: id, tenant_id: TENANT_ID,
      monitoring_date: ymd(addDays(TODAY, -15)),
      care_plan_id: carePlanId,
      assessor_name: "担当ケアマネ (fake)",
      status: "completed",
    });

    console.log(`  ✓ [${idx + 1}/${toInsert.length}] ${c.name} (${c.user_no}) 完了`);
  }

  console.log(`\n✅ 全 ${toInsert.length} 名分の seed 完了`);
}

main().catch((e) => { console.error("💥 例外:", e); process.exit(1); });
