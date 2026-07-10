// OY00x サンプル利用者 (= 訪問介護 fake) の kaigo_assessments.form_data を
// アセスメント form の各タブが read する構造 (face_sheet / family_support /
// service_usage / housing / health / basic_motion / life_function /
// cognition_behavior / social / medical_health / doctor_opinion / summary /
// daily_schedule) で埋める。
//
// 既存 form_data の他 key (= source / ailment / _sample_marker 等) は保持し
// merge upsert する。実 user (OY% 以外) は touch しない。
//
// Usage:
//   node migrations/enrich_assessment_form_data.mjs            # DRY RUN
//   node migrations/enrich_assessment_form_data.mjs --execute  # 本番

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(resolve(__dirname, "..", ".env.local"), "utf8");
const env = Object.fromEntries(
  envText.split(/\r?\n/).filter(l => l && !l.startsWith("#") && l.includes("=")).map(l => {
    const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  })
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const EXECUTE = process.argv.includes("--execute");
console.log(`[mode] ${EXECUTE ? "EXECUTE" : "DRY-RUN"}\n`);

// ─── ヘルパ ───────────────────────────────────────────────────────────────────
function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function emptySupportMatrix(keys) {
  const m = {};
  for (const k of keys) m[k] = { family_exec: false, service_exec: false, wish: false, needs_plan: false };
  return m;
}

function pick(arr, i) {
  return arr[i % arr.length];
}

// 援助マトリクスを「family + service」のパターンに埋める
function fillSupport(keys, opts = {}) {
  const m = emptySupportMatrix(keys);
  const familyIdx = opts.family ?? [];
  const serviceIdx = opts.service ?? [];
  const planIdx = opts.plan ?? [];
  keys.forEach((k, i) => {
    if (familyIdx.includes(i)) m[k].family_exec = true;
    if (serviceIdx.includes(i)) m[k].service_exec = true;
    if (planIdx.includes(i)) m[k].needs_plan = true;
  });
  return m;
}

// ─── per-user 用 サンプルバラエティ ─────────────────────────────────────────
const EMERGENCY_NAMES = [
  ["佐藤 太郎", "長男"], ["田中 花子", "長女"], ["鈴木 健一", "次男"],
  ["高橋 美智子", "長女"], ["伊藤 隆", "甥"], ["渡辺 あや子", "次女"],
  ["山本 修", "長男"], ["中村 信夫", "長男"], ["小林 良子", "長女"], ["加藤 浩", "次男"],
];
const DOCTORS = [
  ["千葉北総合クリニック", "内科", "中村 弘"],
  ["おゆみ野ファミリークリニック", "内科・循環器", "石川 茂"],
  ["花見川リハビリ病院", "リハビリ科", "野村 直美"],
  ["千葉中央メディカル", "整形外科", "大久保 健"],
  ["桜木内科", "内科・神経内科", "渡部 治"],
];
const REFERRAL_ROUTES = [
  "ケアマネジャー紹介", "医療機関より", "家族希望", "地域包括支援センターより", "本人希望（広告）",
];
const AILMENTS = [
  "脳梗塞後遺症", "アルツハイマー型認知症", "パーキンソン病", "変形性膝関節症",
  "心不全 (慢性)", "慢性閉塞性肺疾患 (COPD)", "糖尿病・腎機能低下",
  "脊柱管狭窄症", "うつ病・廃用症候群", "陳旧性脳出血",
];
const LIFE_HISTORIES = [
  "千葉市内で生まれ育つ。長らく専業主婦として家庭を支える。地域の婦人会でも活動。",
  "農家の長男として育ち、定年まで建設業に従事。退職後は自治会の役員を歴任。",
  "学校教員として勤務。退職後は読書と園芸を趣味として穏やかに過ごしてきた。",
  "工場勤務を経て郵便局に転職。地域ボランティアにも長く参加してきた。",
  "看護師として長く勤務。家族の介護経験もあり、生活全般に自立心が強い。",
  "公務員として千葉県内で勤務。退職後は孫の世話と家庭菜園を楽しむ。",
];

// ─── メイン ───────────────────────────────────────────────────────────────────

// 1. OY% clients
const { data: clients, error: e1 } = await sb
  .from("clients")
  .select("id, user_number, name, furigana, gender, birth_date, address, postal_code, phone, mobile, care_level, care_manager, care_manager_org")
  .like("user_number", "OY%")
  .order("user_number");
if (e1) { console.error("clients fetch:", e1.message); process.exit(1); }
console.log(`[1] OY clients: ${clients.length} 名`);

// 2. 対象 assessments (OY user の物のみ)
const oyIds = clients.map(c => c.id);
const { data: assessments, error: e2 } = await sb
  .from("kaigo_assessments")
  .select("id, user_id, assessment_date, form_data")
  .in("user_id", oyIds);
if (e2) { console.error("assessments fetch:", e2.message); process.exit(1); }
console.log(`[2] 対象 assessments: ${assessments.length} 件`);

const clientById = new Map(clients.map(c => [c.id, c]));

// 3. 各 assessment 用に form_data を組み立て
function buildFormData(client, assessment, idx) {
  const existing = assessment.form_data ?? {};
  const [emName, emRel] = pick(EMERGENCY_NAMES, idx);
  const consultName = pick(EMERGENCY_NAMES, idx + 3);
  const doctor = pick(DOCTORS, idx);
  const referral = pick(REFERRAL_ROUTES, idx);
  const ailment = existing.ailment || pick(AILMENTS, idx);
  const lifeHistory = pick(LIFE_HISTORIES, idx);
  const assessmentDate = assessment.assessment_date || isoDaysAgo(30);
  const consultDate = isoDaysAgo(60 + idx * 3);
  const planSubmissionDate = isoDaysAgo(45 + idx * 2);
  const certDate = isoDaysAgo(20 + idx);

  const careLevel = client.care_level || "要介護2";
  const heightCm = String(150 + ((idx * 3) % 20));
  const weightKg = String(45 + ((idx * 4) % 15));

  const phone = client.phone || `043-200-00${String(idx + 1).padStart(2, "0")}`;
  const address = client.address || "千葉県千葉市若葉区桜木1-1-1";

  const face_sheet = {
    consultation_date: consultDate,
    consultation_type: pick(["訪問", "電話", "来所", "訪問"], idx),
    consultation_type_other: "",
    first_receptionist: "担当ケアマネ (fake)",
    emergency_contact: {
      name: emName,
      gender: emRel === "長女" || emRel === "次女" ? "女" : "男",
      age: String(45 + ((idx * 5) % 25)),
      relationship: emRel,
      address: address,
      tel: phone,
      mobile: `090-2345-${String(1000 + idx).padStart(4, "0")}`,
    },
    consultant: {
      name: consultName[0],
      gender: consultName[1] === "長女" || consultName[1] === "次女" ? "女" : "男",
      age: String(50 + ((idx * 4) % 20)),
      relationship: consultName[1],
      address: address,
      tel: phone,
      mobile: `090-3456-${String(2000 + idx).padStart(4, "0")}`,
    },
    referral_route: referral,
    plan_request_submission_date: planSubmissionDate,
    consultation_content_user: `${ailment}による生活上の不便があり、自宅で安心して生活を続けたい。リハビリも続けたい。`,
    consultation_content_family: `本人の意思を尊重しつつ、介護負担を軽減したい。緊急時の対応も整えたい。`,
    life_history: lifeHistory,
    insurance_copay_ratio: pick(["1割", "1割", "2割", "1割"], idx),
    elderly_medical_copay_ratio: pick(["1割", "1割", "2割"], idx),
    high_cost_care_stage: pick(["第3段階", "第4段階", "第2段階", "第4段階"], idx),
    certification_status: "済",
    certification_level: careLevel,
    certification_expected: "",
    certification_date: certDate,
    physical_disability_cert: { has: false, grade: "", type: "", note: "", issue_date: "" },
    intellectual_disability_cert: { has: false, level: "", note: "", issue_date: "" },
    mental_disability_cert: { has: false, grade: "", note: "", issue_date: "" },
    welfare_service_cert: "無",
    self_support_medical_cert: "無",
    disability_support_level: "",
    daily_life_independence: {
      physical: pick(["A1", "A2", "B1", "J2", "A1"], idx),
      physical_judge_organization: "千葉市介護認定審査会",
      physical_judge_date: certDate,
      cognitive: pick(["Ⅰ", "Ⅱa", "Ⅱb", "Ⅰ", "Ⅲa"], idx),
      cognitive_judge_organization: "千葉市介護認定審査会",
      cognitive_judge_date: certDate,
    },
    first_assessment_date: assessmentDate,
  };

  const family_support = {
    family_composition_diagram: "",
    family_care_situation: `主介護者は${emRel} (同居)。日中は仕事のため、通所サービスや訪問介護を併用。`,
    family_members: [
      {
        name: emName,
        is_primary_caregiver: true,
        relationship: emRel,
        relationship_type: emRel === "長女" ? "長女" : emRel === "次女" ? "次女" : emRel === "長男" ? "長男" : emRel === "次男" ? "次男" : emRel === "甥" ? "甥" : emRel === "姪" ? "姪" : emRel === "配偶者" ? (client.gender === "女" ? "夫" : "妻") : "その他",
        parent_member_index: -1,
        living: "同",
        employment: "有",
        health_status: "良好",
        notes: "日中勤務",
      },
      {
        name: consultName[0],
        is_primary_caregiver: false,
        relationship: consultName[1],
        relationship_type: "その他",
        parent_member_index: -1,
        living: pick(["別", "同", "別"], idx),
        employment: "有",
        health_status: "良好",
        notes: "週末に来訪し家事支援",
      },
    ],
    informal_support: [
      { provider: pick(["民生委員", "教会の信徒", "町内会の方", "ボランティア"], idx), content: "見守り訪問・話し相手", notes: "週1回程度" },
    ],
    needed_support: {
      content: "通院同行と買い物代行を希望",
      provider: "訪問介護・家族",
      notes: "事業所と調整中",
    },
  };

  const service_usage = {
    as_of_date: assessmentDate,
    home_services: {
      "訪問介護": { used: true, count: "3", unit: "週" },
      "訪問看護": { used: true, count: "1", unit: "週" },
      "通所介護": { used: pick([true, false, true, true], idx), count: "2", unit: "週" },
      "福祉用具貸与": { used: true, count: "1", unit: "月" },
    },
    other_services: {
      "配食サービス": { used: pick([false, true, false, true], idx), count: "5" },
    },
    recent_admission: { type: "", facility_name: "", postal_code: "", address: "", tel: "" },
    pension: {
      elderly: { checked: true, note: "老齢基礎年金" },
      disability: { checked: false, note: "" },
      survivor: { checked: pick([true, false, false, true], idx), note: pick([true, false, false, true], idx) ? "遺族厚生年金" : "" },
    },
    welfare_programs: {},
    adult_guardianship: "",
    guardian_name: "",
    health_insurance: { "後期高齢者医療制度": true },
    worker_comp: { checked: false, note: "" },
    other_systems: [{ checked: false, note: "" }, { checked: false, note: "" }, { checked: false, note: "" }],
  };

  const housing = {
    type: pick(["1戸建て", "1戸建て", "集合住宅", "1戸建て"], idx),
    tenure: pick(["所有", "所有", "賃貸", "所有"], idx),
    tenure_other: "",
    layout_notes: "1階に居室・トイレ・浴室あり。階段は使用していない。",
    living_room: {
      has_private: "あり",
      floor: ["1階"],
      floor_other: "",
      elevator: "無",
      bed_type: ["介護ベッド"],
      bed_sub: ["電動", "サイドレール"],
      bed_other: "",
      sunlight: "良",
      heating: "あり",
      cooling: "あり",
    },
    toilet: { type: ["洋式"], type_other: "", handrail: "あり", steps: "なし" },
    bathroom: { availability: "自宅にあり", handrail: "あり", steps: pick(["なし", "あり"], idx) },
    mobility: {
      outdoor: { device_use: "使用している", devices: ["車椅子"], other: "" },
      indoor: { device_use: "使用している", devices: ["歩行器", "杖"], other: "" },
    },
    equipment: { cooking: pick(["IH", "ガス"], idx), heating_device: ["エアコン"], heating_other: "" },
    notes: "玄関に段差あり、スロープ設置検討中。",
  };

  const health = {
    medical_history: `${ailment}・高血圧症・脂質異常症`,
    disability_location_notes: pick(["右上下肢に麻痺", "両膝に拘縮", "全身の筋力低下", "右下肢に痺れ"], idx),
    height: heightCm,
    weight: weightKg,
    teeth: { status: ["部分入れ歯"] },
    special_notes: "ペースメーカーなし。血液をサラサラにする薬服用中。",
    medical_visits: [
      {
        disease_name: ailment,
        has_medication: "有",
        onset_date: isoDaysAgo(365 * 3 + idx * 100),
        frequency_type: "定期",
        frequency_unit: "月",
        frequency_count: "1",
        visit_type: "通院",
        facility: doctor[0],
        department: doctor[1],
        doctor: doctor[2],
        tel: "043-300-1000",
        notes: "服薬管理は家族支援",
      },
      {
        disease_name: "高血圧症",
        has_medication: "有",
        onset_date: isoDaysAgo(365 * 5),
        frequency_type: "定期",
        frequency_unit: "月",
        frequency_count: "1",
        visit_type: "通院",
        facility: doctor[0],
        department: "内科",
        doctor: doctor[2],
        tel: "043-300-1000",
        notes: "",
      },
      { disease_name: "", has_medication: "", onset_date: "", frequency_type: "", frequency_unit: "", frequency_count: "", visit_type: "", facility: "", department: "", doctor: "", tel: "", notes: "" },
      { disease_name: "", has_medication: "", onset_date: "", frequency_type: "", frequency_unit: "", frequency_count: "", visit_type: "", facility: "", department: "", doctor: "", tel: "", notes: "" },
    ],
    home_visit_available: { has: "有", facility: doctor[0], tel: "043-300-1000" },
    emergency_hospital: { has: "有", facility: "千葉市立青葉病院", tel: "043-227-1131" },
    pharmacy: { has: "有", name: "おゆみ野薬局", tel: "043-292-0001" },
    life_considerations: "塩分制限 (1日6g以下)、転倒予防のため室内整理。",
  };

  const basic_motion = {
    certification_items: { "1-1": "2", "1-2": "2", "1-3": "1", "2-1": "2", "2-3": "2" },
    body_position: fillSupport(["体位変換介助", "起居介助"], { family: [0], service: [1], plan: [1] }),
    rehab_needed: "あり",
    basic_notes: "起居動作は見守り、移乗に一部介助が必要。リハビリ継続中。",
    bathing: fillSupport(
      ["準備・後始末", "移乗移動介助", "洗身介助", "洗髪介助", "清拭・部分浴", "褥瘡・皮膚疾患の対応"],
      { family: [0, 4], service: [1, 2, 3], plan: [1, 2, 3] }
    ),
    bathing_transfer_current: ["浴室内シャワーチェア使用"],
    bathing_transfer_plan: ["浴室内シャワーチェア使用", "手すり利用"],
    bathing_wash_current: ["背中はヘルパー介助"],
    bathing_wash_plan: ["背中・下肢はヘルパー介助"],
    bathing_notes: "週2回 訪問介護で実施。皮膚状態は良好。",
    communication: {
      visual_aid: ["眼鏡"],
      phone: "あり",
      language_disorder: pick(["なし", "あり", "なし"], idx),
      language_disorder_note: pick(["", "軽度の構音障害あり", ""], idx),
      comm_device: "なし",
      comm_device_note: "",
    },
    communication_notes: "会話は概ね良好。聴力は加齢相応。",
  };

  const life_function = {
    certification_items: { "1-7": "2", "2-1": "2", "2-2": "2", "2-5": "2", "2-6": "2" },
    meals: fillSupport(["移乗介助", "移動介助", "摂取介助"], { family: [0, 1], service: [], plan: [] }),
    main_food: { current: ["軟飯"], current_other: "", plan: ["軟飯"], plan_other: "" },
    side_food: { current: ["一口大"], current_other: "", plan: ["一口大"], plan_other: "" },
    food_intake_support: { current: ["自助具使用"], plan: ["自助具使用"] },
    meal_situation: {
      place: ["居間"],
      place_other: "",
      steps_to_dining: "なし",
      chewing_status: "問題なし",
      chewing_issues: [],
      diet_type: {
        general: true,
        diabetic: { on: pick([false, true, false, false], idx), kcal: pick(["", "1600", "", ""], idx) },
        hypertension: { on: true, grams: "6" },
        anti_ulcer: false,
        other: { on: false, note: "" },
      },
    },
    meal_notes: "1日3食。水分摂取は声かけが必要 (1500ml/日 目標)。",
    toileting: fillSupport(
      ["準備・後始末", "移乗移動介助", "排尿介助", "排便介助", "口腔清潔介助", "洗面介助", "整容介助", "更衣介助"],
      { family: [0, 4, 5, 6], service: [1, 2, 3, 7], plan: [1, 7] }
    ),
    urination_current: ["リハビリパンツ", "ポータブルトイレ夜間"],
    urination_plan: ["リハビリパンツ", "ポータブルトイレ夜間"],
    defecation_current: ["トイレ"],
    defecation_plan: ["トイレ"],
    toilet_awareness: { urination: "ある", defecation: "ある" },
    toilet_notes: "夜間はポータブルトイレ使用。日中は誘導でトイレへ。",
    outing: fillSupport(["移送・外出介助"], { family: [0], service: [0], plan: [0] }),
    outing_notes: "通院は家族同行。買い物はヘルパー代行または家族。",
  };

  const cognition_behavior = {
    cognition_items: { "3-1": "2", "3-2": "2", "3-3": "1", "3-4": "1" },
    behavior_items: { "4-1": "1", "4-3": "1", "4-7": "1" },
    family_observation: "短期記憶の低下あり。怒りっぽさは見られない。",
    support_current: { family: "声かけ・見守り", service: "通所での集団活動 (週2)" },
    support_wish_user: "今までと変わらない生活を続けたい。",
    support_wish_family: "認知症の進行を遅らせたい。",
    support_plan: "通所介護で他者交流を維持し、自宅では家族の声かけと予定の見える化を行う。",
    notes: "服薬カレンダー導入済。",
  };

  const social = {
    certification_items: { "5-1": "2", "5-3": "2", "5-4": "2" },
    money_shopping: fillSupport(["金銭管理", "買い物", "調理", "準備・後始末"], { family: [0, 1, 2, 3], service: [1, 2], plan: [1] }),
    phone_activity: fillSupport(
      ["定期的な相談・助言", "各種書類作成代行", "余暇活動支援", "移送・外出介助", "代読・代筆", "話し相手", "安否確認", "緊急連絡手段の確保", "家族連絡の確保", "社会活動への支援"],
      { family: [0, 1, 4, 5, 6, 7, 8], service: [2, 3, 5, 9], plan: [2, 3] }
    ),
    social_activity: {
      family_relatives: { has: "あり", note: "週末に家族が訪問" },
      neighborhood: { has: pick(["あり", "なし"], idx), note: pick(["近所の方が見守り訪問", ""], idx) },
      friends: { has: pick(["あり", "なし", "あり"], idx), note: pick(["元同僚との電話交流", "", "近隣の友人と月1回お茶"], idx) },
    },
    emergency_method: "緊急通報装置設置済。家族携帯短縮ダイヤル登録。",
    notes: "孤立感の予防が課題。",
  };

  const medical_health = {
    treatments: {
      "服薬管理": true,
      "血糖測定": pick([false, true, false, false], idx),
      "インシュリン注射": false,
      "経管栄養": false,
      "在宅酸素": false,
    },
    support_matrix: fillSupport(
      ["測定・観察", "薬剤の管理", "薬剤の使用", "受診・検査介助", "リハビリテーション", "医療処置の管理"],
      { family: [0, 1, 3], service: [0, 4], plan: [4] }
    ),
    specific_contents_current: ["血圧測定 朝晩", "服薬管理 家族"],
    specific_contents_plan: ["訪問看護による状態観察 週1"],
    notes: "服薬は配薬カレンダーで管理。",
  };

  const doctor_opinion = {
    movement: {
      outdoor_walk: "介助があればしている",
      wheelchair: "主に自分で操作している",
      walk_aid: ["歩行器", "杖"],
    },
    nutrition: {
      eating: "自立ないし何とか自分で食べられる",
      current_status: "良好",
      notes: "体重維持できている",
    },
    current_risks: {
      items: ["転倒", "誤嚥"],
      other: "",
      response: "手すり・歩行器使用、嚥下訓練継続。",
    },
    improvement_outlook: pick(["期待できる", "期待できない", "期待できる", "不明"], idx),
    medical_necessity: {
      "血圧": { checked: true, high: false },
      "脈拍": { checked: true, high: false },
      "服薬": { checked: true, high: true },
    },
    medical_necessity_other: "",
    no_special_item: false,
    observation_points: {
      "誤嚥": { checked: true, note: "食事時の咳込みに注意" },
      "転倒": { checked: true, note: "夜間トイレ時に注意" },
    },
    no_special_observation: false,
    infection: { status: "無", note: "" },
  };

  const summary = {
    notes: `${ailment}による ADL 低下があるものの、本人の生活意欲は維持されている。家族と協働しつつ、訪問介護・通所サービスで在宅生活を継続支援する。`,
    disaster_response: {
      needed: "有",
      individual_plan: pick(["策定中", "有", "策定中"], idx),
      contact: { name: emName, relationship: emRel, tel: phone, fax: "", email: "" },
      notes: "車椅子使用のため、避難時には人手が必要。地域包括と連携。",
    },
    rights_protection: {
      needed: "無",
      notes: "現時点では家族支援で十分。今後の判断能力低下に応じて再評価。",
    },
  };

  // 1日のスケジュール (= 30分刻みの主要時間帯のみ entry を作る)
  function entry(hour, half, life, user_act, fam, svc, needs) {
    return { hour, half, life_rhythm: life, user_activities: user_act, family_support: fam, service_support: svc, needs_support: needs };
  }
  const daily_schedule = {
    entries: [
      entry(6, 0, "起床", "覚醒・着替え", "声かけ", "", ""),
      entry(7, 0, "朝食", "朝食・服薬", "配膳・服薬確認", "", ""),
      entry(9, 0, "活動", "テレビ・読書", "", "", ""),
      entry(10, 0, "通所", "通所介護 (週2)", "", "送迎・入浴・機能訓練", ""),
      entry(12, 0, "昼食", "昼食", "配膳", "", ""),
      entry(13, 0, "休息", "昼寝", "", "", ""),
      entry(14, 0, "訪問介護", "排泄・清拭", "", "訪問介護による身体介護", ""),
      entry(18, 0, "夕食", "夕食・服薬", "調理・服薬確認", "", ""),
      entry(20, 0, "余暇", "テレビ・談話", "見守り", "", ""),
      entry(21, 0, "就寝", "就寝", "声かけ・夜間排泄介助", "", ""),
    ],
  };

  // merge: 既存 key を保持しつつ form セクションを差し込む
  return {
    ...existing,
    ailment, // 既に有る場合も再書込 (= 同じ値)
    source: existing.source || "enrich-form-data",
    _sample_marker: existing._sample_marker || "fake-houmon-2026-06",
    face_sheet,
    family_support,
    service_usage,
    housing,
    health,
    basic_motion,
    life_function,
    cognition_behavior,
    social,
    medical_health,
    doctor_opinion,
    summary,
    daily_schedule,
  };
}

// 4. 件数 + 例示
let countFields = 0;
const updates = [];
assessments.forEach((a, i) => {
  const client = clientById.get(a.user_id);
  if (!client) { console.warn(`  skip: assessment ${a.id} client not found`); return; }
  const fd = buildFormData(client, a, i);
  updates.push({ id: a.id, form_data: fd, user: client.name, user_number: client.user_number });
  // top-level + nested key 数を概算
  function countKeys(obj) {
    let n = 0;
    for (const k of Object.keys(obj)) {
      n++;
      const v = obj[k];
      if (v && typeof v === "object" && !Array.isArray(v)) n += countKeys(v);
      else if (Array.isArray(v)) {
        for (const it of v) if (it && typeof it === "object") n += countKeys(it);
      }
    }
    return n;
  }
  countFields += countKeys(fd);
});

console.log(`[3] 組み立て完了: ${updates.length} 件 / 推定 ${countFields} field 書込`);
console.log(`\n[4] 例: ${updates[0].user_number} ${updates[0].user} の form_data (要約):`);
const sample = updates[0].form_data;
console.log({
  face_sheet_keys: Object.keys(sample.face_sheet).length,
  emergency_contact: sample.face_sheet.emergency_contact,
  consultant: sample.face_sheet.consultant,
  referral_route: sample.face_sheet.referral_route,
  family_members_count: sample.family_support.family_members.length,
  medical_visits_count: sample.health.medical_visits.length,
  daily_schedule_entries: sample.daily_schedule.entries.length,
});

// 5. UPDATE 実行
if (!EXECUTE) {
  console.log("\n--execute で本番。");
  process.exit(0);
}

let ok = 0;
for (const u of updates) {
  const { error } = await sb
    .from("kaigo_assessments")
    .update({ form_data: u.form_data })
    .eq("id", u.id);
  if (error) {
    console.error(`  UPDATE ${u.user_number} (${u.id}):`, error.message);
    continue;
  }
  ok++;
}
console.log(`\n[5] 結果: ${ok}/${updates.length} 件 UPDATE 完了`);
