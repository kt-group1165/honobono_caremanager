/**
 * 訪問介護計画書 (= 指定基準 第28条) の型定義
 *
 * 既存の /visit-procedures (= 手順書) や 居宅ケアプラン (/reports/care-plan-*)
 * とは別物。訪問介護事業所が利用者ごとに作成する法定計画書。
 *
 * 1 user に対し 複数 plan (= version) を保持する想定 (plan_date 降順表示)。
 */

/** 計画書の status (= DB CHECK 制約と一致) */
export const HOUMON_CARE_PLAN_STATUSES = ["draft", "completed"] as const;
export type HoumonCarePlanStatus = (typeof HOUMON_CARE_PLAN_STATUSES)[number];

/** サービス区分 (= 訪問介護報酬区分の主要 enum) */
export const VISIT_CARE_SERVICE_KINDS = [
  "身体1",
  "身体2",
  "身体3",
  "生活2",
  "生活3",
  "身体1生活1",
  "身体1生活2",
  "身体1生活3",
  "身体2生活1",
  "身体2生活2",
  "身体2生活3",
  "通院等乗降介助",
] as const;
export type VisitCareServiceKind = (typeof VISIT_CARE_SERVICE_KINDS)[number];

/** サービス 1 件 (= services JSONB 配列の 1 要素) */
export interface VisitCareService {
  kind: VisitCareServiceKind | "";
  frequency: string;   // 例 "週3回"
  time_range: string;  // 例 "9:00-9:45"
  content: string;     // 具体的内容
}

/** 訪問介護計画書 1 行 */
export interface HoumonCarePlan {
  id?: string;
  tenant_id: string;
  user_id: string;
  office_id: string | null;
  plan_date: string;                // YYYY-MM-DD
  valid_from: string | null;
  valid_until: string | null;
  long_term_goal: string;
  short_term_goal: string;
  user_situation: string;
  family_situation: string;
  services: VisitCareService[];
  special_notes: string;
  author_name: string;
  user_consent_date: string | null;
  user_consent_name: string;
  status: HoumonCarePlanStatus;
  created_at?: string;
  updated_at?: string;
  created_by?: string | null;
}

/** 一覧表示用の軽量サマリ */
export interface HoumonCarePlanSummary {
  id: string;
  plan_date: string;
  valid_from: string | null;
  valid_until: string | null;
  author_name: string | null;
  status: HoumonCarePlanStatus;
  created_at: string;
  updated_at: string;
}

/** 空の plan を返す helper */
export function emptyHoumonCarePlan(
  tenantId: string,
  userId: string,
  officeId: string | null,
): HoumonCarePlan {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const dateStr = `${yyyy}-${mm}-${dd}`;
  return {
    tenant_id: tenantId,
    user_id: userId,
    office_id: officeId,
    plan_date: dateStr,
    valid_from: dateStr,
    valid_until: null,
    long_term_goal: "",
    short_term_goal: "",
    user_situation: "",
    family_situation: "",
    services: [emptyVisitCareService()],
    special_notes: "",
    author_name: "",
    user_consent_date: null,
    user_consent_name: "",
    status: "draft",
  };
}

/** 空の サービス 1 行 */
export function emptyVisitCareService(): VisitCareService {
  return { kind: "", frequency: "", time_range: "", content: "" };
}
