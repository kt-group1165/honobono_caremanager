// テスト利用者向け ケアプラン + アセスメント サンプルデータ作成
//
// 仕様:
//   1. 引数 --user=<uuid> または既定で clients.name = 'test' を対象にする
//   2. 既存の kaigo_care_plans / kaigo_care_plan_services / kaigo_assessments
//      を当該 client について全削除 (clean slate)
//   3. kaigo_care_plans を 1 件 INSERT (status=active, long/short term goals 入り)
//   4. kaigo_care_plan_services を 4 件 INSERT (訪問介護/通所介護/福祉用具/居宅療養管理指導)
//   5. kaigo_assessments を 1 件 INSERT
//      → form_data は 13 タブすべてリアルにフルセット
//        face_sheet / family_support / service_usage / housing / health /
//        basic_motion / life_function / cognition_behavior / social /
//        medical_health / doctor_opinion / summary / daily_schedule
//
// Run: node scripts/create_sample_care_plan_and_assessment.mjs [--user=<uuid>]

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const envPath = resolve(__dirname, "..", ".env.local");
const envText = readFileSync(envPath, "utf8");
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const sb = createClient(SB_URL, SB_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const cliUser = process.argv
  .find((a) => a.startsWith("--user="))
  ?.split("=")[1];

// ============================================================
// 1. client を特定
// ============================================================
let clientId = cliUser ?? null;
let clientName = null;
if (clientId) {
  const { data, error } = await sb
    .from("clients")
    .select("id, name")
    .eq("id", clientId)
    .maybeSingle();
  if (error) {
    console.error("client lookup failed:", error.message);
    process.exit(1);
  }
  if (!data) {
    console.error(`client id=${clientId} が見つかりません`);
    process.exit(1);
  }
  clientName = data.name;
} else {
  const { data, error } = await sb
    .from("clients")
    .select("id, name")
    .eq("name", "test")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("client lookup failed:", error.message);
    process.exit(1);
  }
  if (!data || data.length === 0) {
    console.error("client name='test' が見つかりません (--user=<uuid> で明示してください)");
    process.exit(1);
  }
  clientId = data[0].id;
  clientName = data[0].name;
}
console.log(`[step 1] target client: ${clientName} (${clientId})`);

// ============================================================
// 2. certification を取得 (最新 1 件)
// ============================================================
const { data: certs, error: certErr } = await sb
  .from("client_insurance_records")
  .select("id, care_level, certification_start_date, certification_end_date")
  .eq("client_id", clientId)
  .order("certification_start_date", { ascending: false, nullsFirst: false })
  .limit(1);
if (certErr) {
  console.error("certification lookup failed:", certErr.message);
  process.exit(1);
}
const certId = certs?.[0]?.id ?? null;
const careLevel = certs?.[0]?.care_level ?? "要介護2";
console.log(`[step 2] latest certification_id=${certId ?? "(none)"} care_level=${careLevel}`);

// ============================================================
// 3. 既存データ全削除 (clean slate)
// ============================================================
console.log("[step 3] 既存 care plan / assessment を削除");
// 先に care_plan_services を消す (FK 制約) — care_plan_id 経由
const { data: oldPlans } = await sb
  .from("kaigo_care_plans")
  .select("id")
  .eq("user_id", clientId);
if (oldPlans && oldPlans.length > 0) {
  const oldIds = oldPlans.map((p) => p.id);
  const { error: svcDelErr } = await sb
    .from("kaigo_care_plan_services")
    .delete()
    .in("care_plan_id", oldIds);
  if (svcDelErr) {
    console.error("kaigo_care_plan_services delete failed:", svcDelErr.message);
    // 致命的でないので continue
  }
  const { error: planDelErr } = await sb
    .from("kaigo_care_plans")
    .delete()
    .in("id", oldIds);
  if (planDelErr) {
    console.error("kaigo_care_plans delete failed:", planDelErr.message);
    process.exit(1);
  }
  console.log(`  → kaigo_care_plans ${oldPlans.length} 件削除`);
}
const { error: aDelErr } = await sb
  .from("kaigo_assessments")
  .delete()
  .eq("user_id", clientId);
if (aDelErr) {
  console.error("kaigo_assessments delete failed:", aDelErr.message);
  process.exit(1);
}

// ============================================================
// 4. kaigo_care_plans を INSERT
// ============================================================
console.log("[step 4] kaigo_care_plans INSERT");
const today = new Date();
const ymd = (d) => d.toISOString().slice(0, 10);
const startDate = ymd(new Date(today.getFullYear(), today.getMonth(), 1));
const endDate = ymd(new Date(today.getFullYear() + 1, today.getMonth(), 0));

const { data: planRow, error: planErr } = await sb
  .from("kaigo_care_plans")
  .insert({
    user_id: clientId,
    plan_number: 1,
    plan_type: "居宅サービス計画",
    start_date: startDate,
    end_date: endDate,
    long_term_goals:
      "住み慣れた自宅で安全に暮らし続けることができ、家族との関係を保ちながら、日々の楽しみ (近所への散歩・趣味の園芸) を継続できる。",
    short_term_goals:
      "(1) 入浴を安全に行える (週2回デイで実施)。(2) 自宅内の移動を伝い歩きで自立できる。(3) 服薬管理を訪問介護員の声かけで継続できる。",
    status: "active",
  })
  .select("id")
  .single();
if (planErr) {
  console.error("kaigo_care_plans insert failed:", planErr.message);
  process.exit(1);
}
const planId = planRow.id;
console.log(`  → care_plan id=${planId}`);

// ============================================================
// 5. kaigo_care_plan_services を INSERT (4 件)
// ============================================================
console.log("[step 5] kaigo_care_plan_services INSERT x 4");
const services = [
  {
    care_plan_id: planId,
    service_type: "訪問介護 (身体・生活)",
    service_content:
      "入浴後の更衣介助、服薬声かけ、居室の清掃、買い物代行 (週2)。",
    frequency: "週3回 (月・水・金) 10:00-11:00",
    provider: "KTヘルパーステーション",
    notes: "服薬は朝食後の降圧剤を必ず確認。",
  },
  {
    care_plan_id: planId,
    service_type: "通所介護 (デイサービス)",
    service_content:
      "入浴サービス、機能訓練 (下肢筋力強化)、レクリエーション、口腔体操。",
    frequency: "週2回 (火・木) 9:00-16:30",
    provider: "デイサービスセンターKT",
    notes: "送迎時の段差注意。入浴後は水分摂取を促す。",
  },
  {
    care_plan_id: planId,
    service_type: "福祉用具貸与",
    service_content: "歩行器 (室外用)、ベッド柵、ポータブルトイレ (夜間用)。",
    frequency: "常時",
    provider: "KT福祉用具",
    notes: "6ヶ月毎に状態確認・サイズ再評価。",
  },
  {
    care_plan_id: planId,
    service_type: "居宅療養管理指導",
    service_content: "薬剤師による服薬管理・残薬整理、家族への服薬指導。",
    frequency: "月1回",
    provider: "○○薬局",
    notes: "降圧剤・糖尿病薬の重複に注意。",
  },
];
const { error: svcInsErr } = await sb
  .from("kaigo_care_plan_services")
  .insert(services);
if (svcInsErr) {
  console.error("kaigo_care_plan_services insert failed:", svcInsErr.message);
  process.exit(1);
}

// ============================================================
// 6. kaigo_assessments を INSERT (form_data = 13 タブ完全版)
// ============================================================
console.log("[step 6] kaigo_assessments INSERT (form_data 13 タブ完全版)");

const formData = {
  // ─── Tab 1: フェースシート ───
  face_sheet: {
    consultation_date: startDate,
    consultation_type: "訪問",
    consultation_type_other: "",
    first_receptionist: "山田 介護支援専門員",
    emergency_contact: {
      name: "テスト 太郎",
      gender: "男",
      age: "55",
      relationship: "長男",
      address: "千葉県市原市姉崎海岸1-1-1",
      tel: "0436-00-0000",
      mobile: "090-0000-0000",
    },
    consultant: {
      name: "テスト 花子",
      gender: "女",
      age: "52",
      relationship: "長女",
      address: "千葉県千葉市中央区中央2-2-2",
      tel: "043-000-0000",
      mobile: "090-1111-1111",
    },
    referral_route: "市役所介護保険課からの紹介",
    plan_request_submission_date: startDate,
    consultation_content_user:
      "最近、足腰が弱くなり一人での入浴が不安。週に何度かデイサービスに通いたい。",
    consultation_content_family:
      "服薬の飲み忘れが時々あるので、声かけをしてもらえる訪問サービスを希望。",
    life_history:
      "市原市で生まれ育つ。20歳で結婚し3人の子を育てる。長年自営業 (青果店) を営み、65歳で引退。趣味は園芸と将棋。",
    insurance_copay_ratio: "1割",
    elderly_medical_copay_ratio: "1割",
    high_cost_care_stage: "第2段階",
    certification_status: "済",
    certification_level: careLevel,
    certification_expected: "",
    certification_date: startDate,
    physical_disability_cert: { has: false, grade: "", type: "", note: "", issue_date: "" },
    intellectual_disability_cert: { has: false, level: "", note: "", issue_date: "" },
    mental_disability_cert: { has: false, grade: "", note: "", issue_date: "" },
    welfare_service_cert: "無",
    self_support_medical_cert: "無",
    disability_support_level: "",
    daily_life_independence: {
      physical: "A2",
      physical_judge_organization: "市原市介護認定審査会",
      physical_judge_date: startDate,
      cognitive: "Ⅰ",
      cognitive_judge_organization: "市原市介護認定審査会",
      cognitive_judge_date: startDate,
    },
    first_assessment_date: startDate,
  },

  // ─── Tab 2: 家族状況とインフォーマルな支援 ───
  family_support: {
    family_composition_diagram:
      "本人 (女性82歳) — 夫 (他界) ┬ 長男55歳 (別居・市原市) ┬ 孫2人\n                                          └ 長女52歳 (別居・千葉市)",
    family_care_situation:
      "長男夫婦が週末ごとに訪問。買い物・通院送迎は長男が担当。長女は電話で安否確認を週3回実施。",
    family_members: [
      {
        name: "テスト 太郎",
        is_primary_caregiver: true,
        relationship: "長男",
        relationship_type: "長男",
        parent_member_index: -1,
        living: "別",
        employment: "有",
        health_status: "健康",
        notes: "車で30分。週末ごとに買い物・通院同行。",
      },
      {
        name: "テスト 花子",
        is_primary_caregiver: false,
        relationship: "長女",
        relationship_type: "長女",
        parent_member_index: -1,
        living: "別",
        employment: "有",
        health_status: "健康",
        notes: "電話で週3回安否確認。月1回訪問。",
      },
    ],
    informal_support: [
      { provider: "近隣住民 (鈴木さん)", content: "ゴミ出し補助", notes: "燃えるゴミの日のみ" },
      { provider: "民生委員", content: "月1回の声かけ訪問", notes: "本人も楽しみにしている" },
    ],
    needed_support: {
      content: "緊急時対応 (転倒・体調急変)",
      provider: "長男・近隣鈴木さん",
      notes: "鈴木さんに合鍵を預けている。長男の携帯番号を冷蔵庫に掲示済。",
    },
  },

  // ─── Tab 3: サービス利用状況 ───
  service_usage: {
    as_of_date: startDate,
    home_services: {
      "訪問介護": { used: true, count: "3", unit: "週" },
      "訪問看護": { used: false, count: "", unit: "" },
      "通所介護": { used: true, count: "2", unit: "週" },
      "短期入所生活介護": { used: false, count: "", unit: "" },
      "福祉用具貸与": { used: true, count: "1", unit: "月" },
      "居宅療養管理指導": { used: true, count: "1", unit: "月" },
    },
    other_services: {
      "配食サービス": { used: true, count: "5" },
      "緊急通報装置": { used: true, count: "1" },
    },
    recent_admission: {
      type: "一般病棟",
      facility_name: "市原中央病院",
      postal_code: "290-0000",
      address: "千葉県市原市市原0-0-0",
      tel: "0436-22-0000",
    },
    pension: {
      elderly: { checked: true, note: "国民年金 + 厚生年金" },
      disability: { checked: false, note: "" },
      survivor: { checked: true, note: "夫の遺族年金" },
    },
    welfare_programs: { 生活保護: false, 高齢者福祉手当: true },
    adult_guardianship: "",
    guardian_name: "",
    health_insurance: { 後期高齢者医療: true, 国民健康保険: false },
    worker_comp: { checked: false, note: "" },
    other_systems: [
      { checked: true, note: "高額療養費制度 (申請済)" },
      { checked: false, note: "" },
      { checked: false, note: "" },
    ],
  },

  // ─── Tab 4: 住居等の状況 ───
  housing: {
    type: "1戸建て",
    tenure: "所有",
    tenure_other: "",
    layout_notes:
      "築40年木造平屋。玄関から居室まで段差3箇所あり (5cm程度)。手すりは廊下のみ設置済。",
    living_room: {
      has_private: "あり",
      floor: ["畳"],
      floor_other: "",
      elevator: "無",
      bed_type: ["介護用ベッド"],
      bed_sub: ["電動リクライニング"],
      bed_other: "",
      sunlight: "良",
      heating: "あり",
      cooling: "あり",
    },
    toilet: {
      type: ["洋式", "ウォシュレット"],
      type_other: "",
      handrail: "あり",
      steps: "なし",
    },
    bathroom: { availability: "自宅にあり", handrail: "あり", steps: "あり" },
    mobility: {
      outdoor: { device_use: "使用している", devices: ["歩行器"], other: "" },
      indoor: { device_use: "使用している", devices: ["伝い歩き"], other: "家具を支えに移動" },
    },
    equipment: {
      cooking: "IH",
      heating_device: ["エアコン", "電気カーペット"],
      heating_other: "",
    },
    notes: "玄関段差にスロープ設置を検討中。",
  },

  // ─── Tab 5: 本人の健康状態・受診等の状況 ───
  health: {
    medical_history:
      "高血圧症 (60代より)、変形性膝関節症 (75歳〜)、軽度糖尿病 (78歳〜)、白内障手術 (右眼・80歳)。",
    disability_location_notes: "両膝に軽度の屈曲制限あり。",
    height: "152",
    weight: "48",
    teeth: { status: ["部分入れ歯 (上下)"] },
    special_notes: "アレルギー: 鯖。常用薬: 降圧剤、糖尿病薬、骨粗鬆症薬。",
    medical_visits: [
      {
        disease_name: "高血圧症",
        has_medication: "有",
        onset_date: "2010-04-01",
        frequency_type: "定期",
        frequency_unit: "月",
        frequency_count: "1",
        visit_type: "通院",
        facility: "市原内科クリニック",
        department: "内科",
        doctor: "佐藤医師",
        tel: "0436-11-0000",
        notes: "毎月第2火曜",
      },
      {
        disease_name: "変形性膝関節症",
        has_medication: "有",
        onset_date: "2018-06-01",
        frequency_type: "定期",
        frequency_unit: "月",
        frequency_count: "1",
        visit_type: "通院",
        facility: "市原整形外科",
        department: "整形外科",
        doctor: "鈴木医師",
        tel: "0436-12-0000",
        notes: "ヒアルロン酸注射 (両膝)",
      },
      {
        disease_name: "糖尿病",
        has_medication: "有",
        onset_date: "2021-03-01",
        frequency_type: "定期",
        frequency_unit: "月",
        frequency_count: "1",
        visit_type: "通院",
        facility: "市原内科クリニック",
        department: "内科",
        doctor: "佐藤医師",
        tel: "0436-11-0000",
        notes: "HbA1c 6.8% (安定)",
      },
      {
        disease_name: "白内障 (術後経過観察)",
        has_medication: "無",
        onset_date: "2023-09-01",
        frequency_type: "定期",
        frequency_unit: "月",
        frequency_count: "1",
        visit_type: "通院",
        facility: "市原眼科",
        department: "眼科",
        doctor: "田中医師",
        tel: "0436-13-0000",
        notes: "経過良好",
      },
    ],
    home_visit_available: { has: "有", facility: "市原内科クリニック", tel: "0436-11-0000" },
    emergency_hospital: { has: "有", facility: "市原中央病院", tel: "0436-22-0000" },
    pharmacy: { has: "有", name: "○○薬局", tel: "0436-14-0000" },
    life_considerations:
      "減塩食。糖質制限 (1日 1400kcal 目安)。水分は1日 1.2L 以上。",
  },

  // ─── Tab 6①: 基本（身体機能・起居）動作 ───
  basic_motion: {
    certification_items: { "1-1": "1", "1-2": "2", "1-3": "1", "1-4": "1", "1-5": "1" },
    body_position: {
      "体位変換介助": { family_exec: false, service_exec: false, wish: false, needs_plan: false },
      "起居介助": { family_exec: false, service_exec: true, wish: true, needs_plan: true },
    },
    rehab_needed: "あり",
    basic_notes:
      "起居時に膝痛あり。ベッド柵を活用して自分で起き上がれるが時間がかかる。",
    bathing: {
      "準備・後始末": { family_exec: false, service_exec: true, wish: true, needs_plan: true },
      "移乗移動介助": { family_exec: false, service_exec: true, wish: true, needs_plan: true },
      "洗身介助": { family_exec: false, service_exec: true, wish: true, needs_plan: true },
      "洗髪介助": { family_exec: false, service_exec: true, wish: true, needs_plan: true },
      "清拭・部分浴": { family_exec: false, service_exec: false, wish: false, needs_plan: false },
      "褥瘡・皮膚疾患の対応": { family_exec: false, service_exec: false, wish: false, needs_plan: false },
    },
    bathing_transfer_current: ["手すり"],
    bathing_transfer_plan: ["シャワーチェア", "手すり"],
    bathing_wash_current: ["介助"],
    bathing_wash_plan: ["介助"],
    bathing_notes: "週2回デイサービスで入浴。家庭浴は転倒リスク高く中止中。",
    communication: {
      visual_aid: ["眼鏡"],
      phone: "あり",
      language_disorder: "なし",
      language_disorder_note: "",
      comm_device: "なし",
      comm_device_note: "",
    },
    communication_notes: "聴力は加齢性難聴あるが日常会話は問題なし。",
  },

  // ─── Tab 6②: 生活機能（食事・排泄等）───
  life_function: {
    certification_items: { "2-1": "1", "2-2": "1", "2-3": "2", "2-4": "1" },
    meals: {
      "移乗介助": { family_exec: false, service_exec: false, wish: false, needs_plan: false },
      "移動介助": { family_exec: false, service_exec: false, wish: false, needs_plan: false },
      "摂取介助": { family_exec: false, service_exec: false, wish: false, needs_plan: false },
    },
    main_food: { current: ["普通食"], current_other: "", plan: ["普通食"], plan_other: "" },
    side_food: { current: ["普通食"], current_other: "", plan: ["普通食"], plan_other: "" },
    food_intake_support: { current: [], plan: [] },
    meal_situation: {
      place: ["居間"],
      place_other: "",
      steps_to_dining: "なし",
      chewing_status: "問題なし",
      chewing_issues: [],
      diet_type: {
        general: false,
        diabetic: { on: true, kcal: "1400" },
        hypertension: { on: true, grams: "6" },
        anti_ulcer: false,
        other: { on: false, note: "" },
      },
    },
    meal_notes: "配食サービスを週5回利用。土日は長男夫婦が用意。",
    toileting: {
      "準備・後始末": { family_exec: false, service_exec: false, wish: false, needs_plan: false },
      "移乗移動介助": { family_exec: false, service_exec: false, wish: false, needs_plan: false },
      "排尿介助": { family_exec: false, service_exec: false, wish: false, needs_plan: false },
      "排便介助": { family_exec: false, service_exec: false, wish: false, needs_plan: false },
      "口腔清潔介助": { family_exec: false, service_exec: false, wish: false, needs_plan: false },
      "洗面介助": { family_exec: false, service_exec: false, wish: false, needs_plan: false },
      "整容介助": { family_exec: false, service_exec: false, wish: false, needs_plan: false },
      "更衣介助": { family_exec: false, service_exec: true, wish: true, needs_plan: true },
    },
    urination_current: ["自立"],
    urination_plan: ["自立"],
    defecation_current: ["自立"],
    defecation_plan: ["自立"],
    toilet_awareness: { urination: "ある", defecation: "ある" },
    toilet_notes: "夜間 2-3 回 起きる。ポータブルトイレ使用。",
    outing: {
      "移送・外出介助": { family_exec: true, service_exec: true, wish: true, needs_plan: true },
    },
    outing_notes: "通院は長男が送迎。デイサービスの送迎は事業所が対応。",
  },

  // ─── Tab 6③-④: 認知機能・精神行動障害 ───
  cognition_behavior: {
    cognition_items: { "3-1": "1", "3-2": "1", "3-3": "1", "3-4": "1", "3-5": "1" },
    behavior_items: { "4-1": "1", "4-2": "1", "4-3": "1", "4-4": "1", "4-5": "1" },
    family_observation:
      "短期記憶に時折物忘れあり (薬の飲み忘れなど)。日常生活の判断は問題なし。",
    support_current: {
      family: "週末訪問時に薬の確認・冷蔵庫の食品確認",
      service: "訪問介護で服薬声かけ",
    },
    support_wish_user: "今のところ困ったことはない。声かけがあれば安心。",
    support_wish_family: "服薬・食事の管理を継続してサポートしてほしい。",
    support_plan:
      "訪問介護員による服薬声かけ (週3回) + 居宅療養管理指導 (月1) で服薬管理体制を維持。",
    notes: "認知症の進行兆候は現時点でなし。長谷川式 26点 (2026-04 実施)。",
  },

  // ─── Tab 6⑤: 社会生活（への適応）力 ───
  social: {
    certification_items: { "5-1": "1", "5-2": "1", "5-3": "1", "5-4": "1" },
    money_shopping: {
      "金銭管理": { family_exec: false, service_exec: false, wish: false, needs_plan: false },
      "買い物": { family_exec: true, service_exec: true, wish: true, needs_plan: true },
      "調理": { family_exec: true, service_exec: false, wish: false, needs_plan: false },
      "準備・後始末": { family_exec: false, service_exec: false, wish: false, needs_plan: false },
    },
    phone_activity: {
      "定期的な相談・助言": { family_exec: true, service_exec: false, wish: false, needs_plan: false },
      "各種書類作成代行": { family_exec: true, service_exec: false, wish: false, needs_plan: false },
      "余暇活動支援": { family_exec: false, service_exec: true, wish: true, needs_plan: true },
      "移送・外出介助": { family_exec: true, service_exec: true, wish: true, needs_plan: true },
      "代読・代筆": { family_exec: true, service_exec: false, wish: false, needs_plan: false },
      "話し相手": { family_exec: true, service_exec: true, wish: true, needs_plan: false },
      "安否確認": { family_exec: true, service_exec: true, wish: true, needs_plan: true },
      "緊急連絡手段の確保": { family_exec: false, service_exec: false, wish: true, needs_plan: true },
      "家族連絡の確保": { family_exec: false, service_exec: false, wish: false, needs_plan: false },
      "社会活動への支援": { family_exec: false, service_exec: false, wish: false, needs_plan: false },
    },
    social_activity: {
      family_relatives: { has: "あり", note: "週末家族訪問。月1で孫が来訪。" },
      neighborhood: { has: "あり", note: "近隣の鈴木さんと交流。挨拶程度の付合い数名。" },
      friends: { has: "あり", note: "昔の青果店仲間と電話で月数回。" },
    },
    emergency_method: "緊急通報装置 (ボタン式)、長男携帯番号を冷蔵庫に掲示。",
    notes: "外出機会が減りつつある。デイサービスでの社会的交流を継続したい。",
  },

  // ─── Tab 6⑥: 医療・健康関係 ───
  medical_health: {
    treatments: {
      "点滴の管理": false,
      "中心静脈栄養": false,
      "透析": false,
      "ストーマの処置": false,
      "酸素療法": false,
      "レスピレーター": false,
      "気管切開の処置": false,
      "疼痛の看護": false,
      "経管栄養": false,
      "モニター測定": false,
      "じょくそうの処置": false,
      "カテーテル": false,
    },
    support_matrix: {
      "測定・観察": { family_exec: false, service_exec: true, wish: true, needs_plan: true },
      "薬剤の管理": { family_exec: true, service_exec: true, wish: true, needs_plan: true },
      "薬剤の使用": { family_exec: false, service_exec: true, wish: true, needs_plan: true },
      "受診・検査介助": { family_exec: true, service_exec: false, wish: false, needs_plan: false },
      "リハビリテーション": { family_exec: false, service_exec: true, wish: true, needs_plan: true },
      "医療処置の管理": { family_exec: false, service_exec: false, wish: false, needs_plan: false },
    },
    specific_contents_current: ["服薬管理", "血圧測定 (デイサービスで実施)"],
    specific_contents_plan: ["服薬管理", "血圧・血糖測定", "下肢筋力訓練"],
    notes:
      "服薬は朝・夕の2回。朝食後の降圧剤は本人忘れがちのため訪問介護員が声かけ。",
  },

  // ─── Tab 6医: 介護に関する医師の意見 ───
  doctor_opinion: {
    movement: {
      outdoor_walk: "介助があればしている",
      wheelchair: "用いていない",
      walk_aid: ["歩行器", "T字杖"],
    },
    nutrition: {
      eating: "自立ないし何とか自分で食べられる",
      current_status: "良好",
      notes: "BMI 20.8 (適正)。低栄養の兆候なし。",
    },
    current_risks: {
      items: ["転倒", "脱水", "低血糖"],
      other: "",
      response: "歩行器使用の徹底、夏期の水分摂取声かけ、糖尿病薬服用後の食事タイミング確認。",
    },
    improvement_outlook: "期待できる",
    medical_necessity: {
      "血圧の管理": { checked: true, high: false },
      "血糖の管理": { checked: true, high: false },
      "服薬管理": { checked: true, high: true },
    },
    medical_necessity_other: "",
    no_special_item: false,
    observation_points: {
      "血圧変動": { checked: true, note: "朝の降圧剤後に低血圧傾向。" },
      "膝関節痛": { checked: true, note: "雨天時に痛み増強。" },
    },
    no_special_observation: false,
    infection: { status: "無", note: "" },
  },

  // ─── Tab 7まとめ: 全体のまとめ ───
  summary: {
    notes:
      "ADL は概ね自立しているが、入浴・更衣・服薬に部分介助が必要。家族の協力体制は良好で、訪問介護 + 通所介護 + 居宅療養管理指導の組合せで在宅生活継続が可能。短期目標 (3ヶ月) は転倒予防と服薬の継続。長期目標 (1年) は現在の自立度の維持。",
    disaster_response: {
      needed: "有",
      individual_plan: "策定中",
      contact: {
        name: "テスト 太郎",
        relationship: "長男",
        tel: "090-0000-0000",
        fax: "",
        email: "taro@example.com",
      },
      notes:
        "災害時の一次避難先は市原市姉崎公民館。長男が迎えに行く。常用薬は1週間分を非常持ち出し袋に常備済。",
    },
    rights_protection: {
      needed: "有",
      notes:
        "判断能力は現状問題ないが、将来的に成年後見制度の情報提供を行う予定。",
    },
  },

  // ─── Tab 7スケジュ: 1日のスケジュール ───
  daily_schedule: {
    entries: [
      { hour: 6, half: 0, life_rhythm: "起床", user_activities: "起床・洗面", family_support: "", service_support: "", needs_support: "" },
      { hour: 7, half: 0, life_rhythm: "朝食", user_activities: "朝食 (配食)", family_support: "", service_support: "", needs_support: "服薬声かけ" },
      { hour: 8, half: 0, life_rhythm: "服薬・新聞", user_activities: "降圧剤・糖尿病薬服薬", family_support: "", service_support: "", needs_support: "" },
      { hour: 9, half: 0, life_rhythm: "活動 (デイ送迎)", user_activities: "火・木はデイサービス出発", family_support: "", service_support: "デイサービス送迎", needs_support: "" },
      { hour: 10, half: 0, life_rhythm: "訪問介護 (月・水・金)", user_activities: "服薬声かけ・清掃・買い物", family_support: "", service_support: "訪問介護", needs_support: "服薬管理・買い物" },
      { hour: 12, half: 0, life_rhythm: "昼食", user_activities: "昼食 (配食)", family_support: "", service_support: "", needs_support: "" },
      { hour: 13, half: 0, life_rhythm: "休息", user_activities: "昼寝 1時間", family_support: "", service_support: "", needs_support: "" },
      { hour: 14, half: 0, life_rhythm: "趣味", user_activities: "テレビ・園芸 (天気の良い日)", family_support: "", service_support: "", needs_support: "" },
      { hour: 16, half: 0, life_rhythm: "デイ帰宅", user_activities: "火・木デイから帰宅", family_support: "", service_support: "デイ送迎", needs_support: "" },
      { hour: 18, half: 0, life_rhythm: "夕食", user_activities: "夕食 (土日は家族と)", family_support: "土日は長男夫婦が用意", service_support: "", needs_support: "" },
      { hour: 19, half: 0, life_rhythm: "服薬", user_activities: "降圧剤服薬", family_support: "", service_support: "", needs_support: "" },
      { hour: 20, half: 0, life_rhythm: "入浴 (デイ未利用日は清拭)", user_activities: "テレビ視聴", family_support: "", service_support: "", needs_support: "" },
      { hour: 21, half: 0, life_rhythm: "就寝準備", user_activities: "歯磨き・着替え", family_support: "", service_support: "", needs_support: "更衣声かけ" },
      { hour: 22, half: 0, life_rhythm: "就寝", user_activities: "就寝", family_support: "", service_support: "", needs_support: "" },
      { hour: 1, half: 0, life_rhythm: "夜間トイレ", user_activities: "ポータブルトイレ使用", family_support: "", service_support: "", needs_support: "転倒注意" },
      { hour: 4, half: 0, life_rhythm: "夜間トイレ", user_activities: "ポータブルトイレ使用", family_support: "", service_support: "", needs_support: "転倒注意" },
    ],
  },

  // 旧形式 (後方互換)
  assessor_name: "山田 介護支援専門員",
};

const { data: aRow, error: aInsErr } = await sb
  .from("kaigo_assessments")
  .insert({
    user_id: clientId,
    certification_id: certId,
    assessment_date: startDate,
    assessor_name: "山田 介護支援専門員",
    status: "completed",
    form_data: formData,
  })
  .select("id")
  .single();
if (aInsErr) {
  console.error("kaigo_assessments insert failed:", aInsErr.message);
  process.exit(1);
}

console.log(`  → assessment id=${aRow.id}`);

console.log(`
✅ サンプルデータ投入完了
   client:     ${clientName} (${clientId})
   care_plan:  1 件 (services 4 件付き)
   assessment: 1 件 (form_data 13 タブ完全版)

確認:
   - /users/${clientId}/care-plan
   - /assessments?user=${clientId}
`);
