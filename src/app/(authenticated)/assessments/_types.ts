// ─── Assessment Form Types ────────────────────────────────────────────────────
// 公式ケアマネジメント様式 13セクション構成

export interface ContactInfo {
  name: string;
  gender: "男" | "女" | "";
  age: string;
  relationship: string;
  address: string;
  tel: string;
  mobile: string;
}

/**
 * 続柄タイプ（構造化プルダウン用）
 * 家系図の配置・性別を正確に決定するために使用
 */
export type RelationshipType =
  | "夫" | "妻"
  | "父" | "母" | "義父" | "義母"
  | "長男" | "長女" | "次男" | "次女" | "三男" | "三女"
  | "長男の妻" | "長女の夫" | "次男の妻" | "次女の夫"
  | "孫（男）" | "孫（女）"
  | "兄" | "姉" | "弟" | "妹"
  | "甥" | "姪" | "叔父" | "叔母" | "いとこ"
  | "友人・知人"
  | "その他";

export interface FamilyMember {
  name: string;
  is_primary_caregiver: boolean;
  relationship: string;           // 自由入力テキスト（従来互換・表示用）
  relationship_type?: RelationshipType; // 構造化プルダウン値
  parent_member_index?: number;   // 孫の場合: 親にあたるメンバーのindex (-1=未指定)
  living: "同" | "別" | "";
  employment: "有" | "無" | "";
  health_status: string;
  notes: string;
}

export interface InformalSupport {
  provider: string;
  content: string;
  notes: string;
}

export interface MedicalVisit {
  disease_name: string;
  has_medication: "有" | "無" | "";
  onset_date: string;
  frequency_type: "定期" | "不定期" | "";
  frequency_unit: "週" | "月" | "";
  frequency_count: string;
  visit_type: "通院" | "往診" | "";
  facility: string;
  department: string;
  doctor: string;
  tel: string;
  notes: string;
}

/**
 * 援助の現状マトリクス
 * 各行: family / service / wish / needs (plan)
 */
export type SupportMatrixRow = {
  family_exec: boolean;
  service_exec: boolean;
  wish: boolean;
  needs_plan: boolean;
};
export type SupportMatrix = Record<string, SupportMatrixRow>;

// ─── Tab 1: フェースシート ─────────────────────────────────────────────────────

export interface FaceSheet {
  consultation_date: string;
  consultation_type: "訪問" | "電話" | "来所" | "その他" | "";
  consultation_type_other: string;
  first_receptionist: string;
  emergency_contact: ContactInfo;
  consultant: ContactInfo;
  referral_route: string;
  plan_request_submission_date: string;
  consultation_content_user: string;
  consultation_content_family: string;
  life_history: string;
  // 介護保険
  insurance_copay_ratio: "1割" | "2割" | "3割" | "";
  elderly_medical_copay_ratio: "1割" | "2割" | "3割" | "";
  high_cost_care_stage: "第1段階" | "第2段階" | "第3段階" | "第4段階" | "第5段階" | "";
  certification_status: "済" | "未(見込み)" | "";
  certification_level: string;
  certification_expected: string;
  certification_date: string;
  physical_disability_cert: { has: boolean; grade: string; type: string; note: string; issue_date: string };
  intellectual_disability_cert: { has: boolean; level: string; note: string; issue_date: string };
  mental_disability_cert: { has: boolean; grade: string; note: string; issue_date: string };
  welfare_service_cert: "有" | "無" | "";
  self_support_medical_cert: "有" | "無" | "";
  disability_support_level: string;
  daily_life_independence: {
    physical: string;
    physical_judge_organization: string;
    physical_judge_date: string;
    cognitive: string;
    cognitive_judge_organization: string;
    cognitive_judge_date: string;
  };
  first_assessment_date: string;
}

// ─── Tab 2: 家族状況とインフォーマルな支援 ──────────────────────────────────

export interface FamilySupport {
  family_composition_diagram: string;
  family_care_situation: string;
  family_members: FamilyMember[];
  informal_support: InformalSupport[];
  needed_support: {
    content: string;
    provider: string;
    notes: string;
  };
}

// ─── Tab 3: サービス利用状況 ────────────────────────────────────────────────

export interface ServiceUsage {
  as_of_date: string;
  home_services: Record<string, { used: boolean; count: string; unit: string }>;
  other_services: Record<string, { used: boolean; count: string }>;
  recent_admission: {
    type: string;
    facility_name: string;
    postal_code: string;
    address: string;
    tel: string;
  };
  pension: {
    elderly: { checked: boolean; note: string };
    disability: { checked: boolean; note: string };
    survivor: { checked: boolean; note: string };
  };
  welfare_programs: Record<string, boolean>;
  adult_guardianship: "後見" | "保佐" | "補助" | "";
  guardian_name: string;
  health_insurance: Record<string, boolean>;
  worker_comp: { checked: boolean; note: string };
  other_systems: { checked: boolean; note: string }[];
}

// ─── Tab 4: 住居等の状況 ─────────────────────────────────────────────────────

export interface Housing {
  type: "1戸建て" | "集合住宅" | "";
  tenure: "賃貸" | "所有" | "社宅等" | "公営住宅" | "その他" | "";
  tenure_other: string;
  layout_notes: string;
  living_room: {
    has_private: "あり" | "なし" | "";
    floor: string[];
    floor_other: string;
    elevator: "有" | "無" | "";
    bed_type: string[];
    bed_sub: string[];
    bed_other: string;
    sunlight: "良" | "普通" | "悪" | "";
    heating: "あり" | "なし" | "";
    cooling: "あり" | "なし" | "";
  };
  toilet: {
    type: string[];
    type_other: string;
    handrail: "あり" | "なし" | "";
    steps: "あり" | "なし" | "";
  };
  bathroom: {
    availability: "自宅にあり" | "自宅になし" | "";
    handrail: "あり" | "なし" | "";
    steps: "あり" | "なし" | "";
  };
  mobility: {
    outdoor: { device_use: "使用している" | "使用していない" | ""; devices: string[]; other: string };
    indoor: { device_use: "使用している" | "使用していない" | ""; devices: string[]; other: string };
  };
  equipment: {
    cooking: "ガス" | "IH" | "";
    heating_device: string[];
    heating_other: string;
  };
  notes: string;
}

// ─── Tab 5: 本人の健康状態・受診等の状況 ─────────────────────────────────────

export interface Health {
  medical_history: string;
  disability_location_notes: string;
  height: string;
  weight: string;
  teeth: {
    status: string[];
  };
  special_notes: string;
  medical_visits: MedicalVisit[];
  home_visit_available: { has: "有" | "無" | ""; facility: string; tel: string };
  emergency_hospital: { has: "有" | "無" | ""; facility: string; tel: string };
  pharmacy: { has: "有" | "無" | ""; name: string; tel: string };
  life_considerations: string;
}

// ─── Tab 6①: 基本（身体機能・起居）動作 ────────────────────────────────────

export interface BasicMotion {
  certification_items: Record<string, string>; // "1-1" -> "1,2,3" (複数可はカンマ区切り) または "2"
  body_position: SupportMatrix;
  rehab_needed: "あり" | "なし" | "";
  basic_notes: string;
  bathing: SupportMatrix;
  bathing_transfer_current: string[];
  bathing_transfer_plan: string[];
  bathing_wash_current: string[];
  bathing_wash_plan: string[];
  bathing_notes: string;
  communication: {
    visual_aid: string[];
    phone: "あり" | "なし" | "";
    language_disorder: "あり" | "なし" | "";
    language_disorder_note: string;
    comm_device: "あり" | "なし" | "";
    comm_device_note: string;
  };
  communication_notes: string;
}

// ─── Tab 6②: 生活機能（食事・排泄等）────────────────────────────────────────

export interface LifeFunction {
  certification_items: Record<string, string>;
  meals: SupportMatrix;
  main_food: { current: string[]; current_other: string; plan: string[]; plan_other: string };
  side_food: { current: string[]; current_other: string; plan: string[]; plan_other: string };
  food_intake_support: { current: string[]; plan: string[] };
  meal_situation: {
    place: string[];
    place_other: string;
    steps_to_dining: "あり" | "なし" | "";
    chewing_status: "問題なし" | "問題あり" | "";
    chewing_issues: string[];
    diet_type: {
      general: boolean;
      diabetic: { on: boolean; kcal: string };
      hypertension: { on: boolean; grams: string };
      anti_ulcer: boolean;
      other: { on: boolean; note: string };
    };
  };
  meal_notes: string;
  toileting: SupportMatrix;
  urination_current: string[];
  urination_plan: string[];
  defecation_current: string[];
  defecation_plan: string[];
  toilet_awareness: {
    urination: "ある" | "ときどきある" | "ない" | "";
    defecation: "ある" | "ときどきある" | "ない" | "";
  };
  toilet_notes: string;
  outing: SupportMatrix;
  outing_notes: string;
}

// ─── Tab 6③-④: 認知機能・精神行動障害 ──────────────────────────────────────

export interface CognitionBehavior {
  cognition_items: Record<string, string>;
  behavior_items: Record<string, string>;
  family_observation: string;
  support_current: { family: string; service: string };
  support_wish_user: string;
  support_wish_family: string;
  support_plan: string;
  notes: string;
}

// ─── Tab 6⑤: 社会生活（への適応）力 ────────────────────────────────────────

export interface Social {
  certification_items: Record<string, string>;
  money_shopping: SupportMatrix;
  phone_activity: SupportMatrix;
  social_activity: {
    family_relatives: { has: "あり" | "なし" | ""; note: string };
    neighborhood: { has: "あり" | "なし" | ""; note: string };
    friends: { has: "あり" | "なし" | ""; note: string };
  };
  emergency_method: string;
  notes: string;
}

// ─── Tab 6⑥: 医療・健康関係 ─────────────────────────────────────────────────

export interface MedicalHealth {
  treatments: Record<string, boolean>;
  support_matrix: SupportMatrix;
  specific_contents_current: string[];
  specific_contents_plan: string[];
  notes: string;
}

// ─── Tab 6医: 介護に関する医師の意見 ───────────────────────────────────────

export interface DoctorOpinion {
  movement: {
    outdoor_walk: "自立" | "介助があればしている" | "していない" | "";
    wheelchair: "用いていない" | "主に自分で操作している" | "主に他人が操作している" | "";
    walk_aid: string[];
  };
  nutrition: {
    eating: "自立ないし何とか自分で食べられる" | "全面介助" | "";
    current_status: "良好" | "不良" | "";
    notes: string;
  };
  current_risks: {
    items: string[];
    other: string;
    response: string;
  };
  improvement_outlook: "期待できる" | "期待できない" | "不明" | "";
  medical_necessity: Record<string, { checked: boolean; high: boolean }>;
  medical_necessity_other: string;
  no_special_item: boolean;
  observation_points: Record<string, { checked: boolean; note: string }>;
  no_special_observation: boolean;
  infection: { status: "無" | "有" | "不明" | ""; note: string };
}

// ─── Tab 7まとめ: 全体のまとめ ───────────────────────────────────────────────

export interface SummarySection {
  notes: string;
  disaster_response: {
    needed: "有" | "無" | "";
    individual_plan: "有" | "策定中" | "無" | "";
    contact: { name: string; relationship: string; tel: string; fax: string; email: string };
    notes: string;
  };
  rights_protection: {
    needed: "有" | "無" | "";
    notes: string;
  };
}

// ─── Tab 7スケジュ: 1日のスケジュール ──────────────────────────────────────

export interface ScheduleEntry {
  hour: number; // 0-23
  half: 0 | 1; // 0=前半30分, 1=後半30分
  life_rhythm: string;
  user_activities: string;
  family_support: string;
  service_support: string;
  needs_support: string;
}

export interface DailySchedule {
  entries: ScheduleEntry[];
}

// ─── 統合型 ────────────────────────────────────────────────────────────────────

export interface AssessmentFormData {
  face_sheet?: FaceSheet;
  family_support?: FamilySupport;
  service_usage?: ServiceUsage;
  housing?: Housing;
  health?: Health;
  basic_motion?: BasicMotion;
  life_function?: LifeFunction;
  cognition_behavior?: CognitionBehavior;
  social?: Social;
  medical_health?: MedicalHealth;
  doctor_opinion?: DoctorOpinion;
  summary?: SummarySection;
  daily_schedule?: DailySchedule;

  // 旧形式フィールド（後方互換・表示のみ使用）
  assessor_name?: string;
  family_situation?: string;
  informal_support?: string;
  current_services?: string;
  housing_type?: string;
  housing_situation?: string;
  housing_issues?: string;
  health_condition?: string;
  medical_visits?: string;
  medications?: string;
  [key: string]: unknown;
}

// ─── 初期値生成 ───────────────────────────────────────────────────────────────

function emptyContact(): ContactInfo {
  return { name: "", gender: "", age: "", relationship: "", address: "", tel: "", mobile: "" };
}

export function emptyFaceSheet(): FaceSheet {
  return {
    consultation_date: "",
    consultation_type: "",
    consultation_type_other: "",
    first_receptionist: "",
    emergency_contact: emptyContact(),
    consultant: emptyContact(),
    referral_route: "",
    plan_request_submission_date: "",
    consultation_content_user: "",
    consultation_content_family: "",
    life_history: "",
    insurance_copay_ratio: "",
    elderly_medical_copay_ratio: "",
    high_cost_care_stage: "",
    certification_status: "",
    certification_level: "",
    certification_expected: "",
    certification_date: "",
    physical_disability_cert: { has: false, grade: "", type: "", note: "", issue_date: "" },
    intellectual_disability_cert: { has: false, level: "", note: "", issue_date: "" },
    mental_disability_cert: { has: false, grade: "", note: "", issue_date: "" },
    welfare_service_cert: "",
    self_support_medical_cert: "",
    disability_support_level: "",
    daily_life_independence: {
      physical: "",
      physical_judge_organization: "",
      physical_judge_date: "",
      cognitive: "",
      cognitive_judge_organization: "",
      cognitive_judge_date: "",
    },
    first_assessment_date: "",
  };
}

export function emptyFamilyMember(): FamilyMember {
  return {
    name: "",
    is_primary_caregiver: false,
    relationship: "",
    relationship_type: "その他",
    parent_member_index: -1,
    living: "",
    employment: "",
    health_status: "",
    notes: "",
  };
}

export function emptyMedicalVisit(): MedicalVisit {
  return {
    disease_name: "",
    has_medication: "",
    onset_date: "",
    frequency_type: "",
    frequency_unit: "",
    frequency_count: "",
    visit_type: "",
    facility: "",
    department: "",
    doctor: "",
    tel: "",
    notes: "",
  };
}

export function emptySupportMatrix(keys: string[]): SupportMatrix {
  const m: SupportMatrix = {};
  for (const k of keys) {
    m[k] = { family_exec: false, service_exec: false, wish: false, needs_plan: false };
  }
  return m;
}

export function emptyAssessment(): AssessmentFormData {
  return {
    face_sheet: emptyFaceSheet(),
    family_support: {
      family_composition_diagram: "",
      family_care_situation: "",
      family_members: [emptyFamilyMember()],
      informal_support: [{ provider: "", content: "", notes: "" }],
      needed_support: { content: "", provider: "", notes: "" },
    },
    service_usage: {
      as_of_date: "",
      home_services: {},
      other_services: {},
      recent_admission: { type: "", facility_name: "", postal_code: "", address: "", tel: "" },
      pension: {
        elderly: { checked: false, note: "" },
        disability: { checked: false, note: "" },
        survivor: { checked: false, note: "" },
      },
      welfare_programs: {},
      adult_guardianship: "",
      guardian_name: "",
      health_insurance: {},
      worker_comp: { checked: false, note: "" },
      other_systems: [{ checked: false, note: "" }, { checked: false, note: "" }, { checked: false, note: "" }],
    },
    housing: {
      type: "",
      tenure: "",
      tenure_other: "",
      layout_notes: "",
      living_room: {
        has_private: "",
        floor: [],
        floor_other: "",
        elevator: "",
        bed_type: [],
        bed_sub: [],
        bed_other: "",
        sunlight: "",
        heating: "",
        cooling: "",
      },
      toilet: { type: [], type_other: "", handrail: "", steps: "" },
      bathroom: { availability: "", handrail: "", steps: "" },
      mobility: {
        outdoor: { device_use: "", devices: [], other: "" },
        indoor: { device_use: "", devices: [], other: "" },
      },
      equipment: { cooking: "", heating_device: [], heating_other: "" },
      notes: "",
    },
    health: {
      medical_history: "",
      disability_location_notes: "",
      height: "",
      weight: "",
      teeth: { status: [] },
      special_notes: "",
      medical_visits: [emptyMedicalVisit(), emptyMedicalVisit(), emptyMedicalVisit(), emptyMedicalVisit()],
      home_visit_available: { has: "", facility: "", tel: "" },
      emergency_hospital: { has: "", facility: "", tel: "" },
      pharmacy: { has: "", name: "", tel: "" },
      life_considerations: "",
    },
    basic_motion: {
      certification_items: {},
      body_position: emptySupportMatrix(["体位変換介助", "起居介助"]),
      rehab_needed: "",
      basic_notes: "",
      bathing: emptySupportMatrix(["準備・後始末", "移乗移動介助", "洗身介助", "洗髪介助", "清拭・部分浴", "褥瘡・皮膚疾患の対応"]),
      bathing_transfer_current: [],
      bathing_transfer_plan: [],
      bathing_wash_current: [],
      bathing_wash_plan: [],
      bathing_notes: "",
      communication: {
        visual_aid: [],
        phone: "",
        language_disorder: "",
        language_disorder_note: "",
        comm_device: "",
        comm_device_note: "",
      },
      communication_notes: "",
    },
    life_function: {
      certification_items: {},
      meals: emptySupportMatrix(["移乗介助", "移動介助", "摂取介助"]),
      main_food: { current: [], current_other: "", plan: [], plan_other: "" },
      side_food: { current: [], current_other: "", plan: [], plan_other: "" },
      food_intake_support: { current: [], plan: [] },
      meal_situation: {
        place: [],
        place_other: "",
        steps_to_dining: "",
        chewing_status: "",
        chewing_issues: [],
        diet_type: {
          general: false,
          diabetic: { on: false, kcal: "" },
          hypertension: { on: false, grams: "" },
          anti_ulcer: false,
          other: { on: false, note: "" },
        },
      },
      meal_notes: "",
      toileting: emptySupportMatrix([
        "準備・後始末", "移乗移動介助", "排尿介助", "排便介助",
        "口腔清潔介助", "洗面介助", "整容介助", "更衣介助",
      ]),
      urination_current: [],
      urination_plan: [],
      defecation_current: [],
      defecation_plan: [],
      toilet_awareness: { urination: "", defecation: "" },
      toilet_notes: "",
      outing: emptySupportMatrix(["移送・外出介助"]),
      outing_notes: "",
    },
    cognition_behavior: {
      cognition_items: {},
      behavior_items: {},
      family_observation: "",
      support_current: { family: "", service: "" },
      support_wish_user: "",
      support_wish_family: "",
      support_plan: "",
      notes: "",
    },
    social: {
      certification_items: {},
      money_shopping: emptySupportMatrix(["金銭管理", "買い物", "調理", "準備・後始末"]),
      phone_activity: emptySupportMatrix([
        "定期的な相談・助言", "各種書類作成代行", "余暇活動支援", "移送・外出介助", "代読・代筆",
        "話し相手", "安否確認", "緊急連絡手段の確保", "家族連絡の確保", "社会活動への支援",
      ]),
      social_activity: {
        family_relatives: { has: "", note: "" },
        neighborhood: { has: "", note: "" },
        friends: { has: "", note: "" },
      },
      emergency_method: "",
      notes: "",
    },
    medical_health: {
      treatments: {},
      support_matrix: emptySupportMatrix([
        "測定・観察", "薬剤の管理", "薬剤の使用", "受診・検査介助", "リハビリテーション", "医療処置の管理",
      ]),
      specific_contents_current: [],
      specific_contents_plan: [],
      notes: "",
    },
    doctor_opinion: {
      movement: { outdoor_walk: "", wheelchair: "", walk_aid: [] },
      nutrition: { eating: "", current_status: "", notes: "" },
      current_risks: { items: [], other: "", response: "" },
      improvement_outlook: "",
      medical_necessity: {},
      medical_necessity_other: "",
      no_special_item: false,
      observation_points: {},
      no_special_observation: false,
      infection: { status: "", note: "" },
    },
    summary: {
      notes: "",
      disaster_response: {
        needed: "",
        individual_plan: "",
        contact: { name: "", relationship: "", tel: "", fax: "", email: "" },
        notes: "",
      },
      rights_protection: { needed: "", notes: "" },
    },
    daily_schedule: { entries: [] },
  };
}
