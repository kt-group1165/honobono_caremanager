/**
 * 訪問介護計画書 (= 指定基準 第28条) の型定義 v2 (2026-08-07)
 *
 * ほのぼの NEXT「訪問介護計画書作成編」の流れに対応:
 *   Ⅰ カンファレンス          → /care-conferences (kaigo_care_conferences)
 *   Ⅱ 訪問介護計画書           → ここ (kaigo_houmon_care_plans)
 *   Ⅱ-2 個別援助詳細計画(手順書) → /visit-procedures (kaigo_visit_procedure_documents)
 *   Ⅲ 個別援助実施記録          → /visit-records
 *
 * v2 変更点:
 *   - long_term_goal / short_term_goal (単一 TEXT) → goals[] (ニーズ+長期+短期+各期間)
 *   - services[] (頻度・時間帯の自由文) → weekly_services[] (曜日 + 開始/終了時刻)
 *   - 本人/家族の意向・援助の基本方針・留意事項・緊急時対応・説明日/代理人同意 を追加
 *   - 作成区分 (初回/変更/更新)・初回作成日・計画作成者 を追加
 *   - 居宅サービス計画書 (第1表/第2表) からの取込に対応するリンク列
 *
 * 1 user に対し 複数 plan (= version) を保持 (plan_date 降順表示)。
 */

/** 計画書の status (= DB CHECK 制約と一致) */
export const HOUMON_CARE_PLAN_STATUSES = ["draft", "completed"] as const;
export type HoumonCarePlanStatus = (typeof HOUMON_CARE_PLAN_STATUSES)[number];

/** 作成区分 (= DB CHECK 制約と一致) */
export const HOUMON_PLAN_KINDS = ["初回", "変更", "更新"] as const;
export type HoumonPlanKind = (typeof HOUMON_PLAN_KINDS)[number];

/** サービス区分 (= 訪問介護報酬区分の主要 enum。手順書 v2 と同じ並び + 通院等乗降介助) */
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

/** 曜日キー (手順書 v2 の WEEKDAY_KEYS と同じ並び) */
export const WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

export const WEEKDAY_LABELS: Record<WeekdayKey, string> = {
  mon: "月",
  tue: "火",
  wed: "水",
  thu: "木",
  fri: "金",
  sat: "土",
  sun: "日",
};

/** ニーズ・目標 1 行 (= goals JSONB 配列の 1 要素) */
export interface HoumonGoalRow {
  /** 生活全般の解決すべき課題 (ニーズ) */
  needs: string;
  long_term_goal: string;
  long_term_period: string;
  short_term_goal: string;
  short_term_period: string;
}

/** 週間サービス計画 1 行 (= weekly_services JSONB 配列の 1 要素) */
export interface WeeklyServiceRow {
  days: WeekdayKey[];
  /** "HH:MM" */
  start_time: string;
  /** "HH:MM" */
  end_time: string;
  service_kind: VisitCareServiceKind | "";
  /** 援助内容 (具体的なサービス内容) */
  content: string;
  /** 留意点 / 担当者メモ */
  notes: string;
}

/** 訪問介護計画書 1 行 */
export interface HoumonCarePlan {
  id?: string;
  tenant_id: string;
  user_id: string;
  office_id: string | null;

  // ── 基本情報 ──
  plan_kind: HoumonPlanKind;
  plan_date: string; // 計画作成日 YYYY-MM-DD
  initial_plan_date: string | null; // 初回作成日
  valid_from: string | null;
  valid_until: string | null;
  /** サービス提供責任者 */
  author_name: string;
  /** 計画作成者 (提供責任者と別の場合) */
  creator_name: string;

  // ── 意向・方針 ──
  user_intention: string;
  family_intention: string;
  basic_policy: string;

  // ── 状況 ──
  user_situation: string;
  family_situation: string;

  // ── 目標 / サービス ──
  goals: HoumonGoalRow[];
  weekly_services: WeeklyServiceRow[];

  // ── 留意事項 ──
  precautions: string;
  emergency_response: string;
  special_notes: string;

  // ── 同意 ──
  explained_on: string | null;
  user_consent_date: string | null;
  user_consent_name: string;
  consent_proxy_name: string;
  consent_proxy_relation: string;

  // ── リンク ──
  source_care_plan_doc_id: string | null;
  conference_id: string | null;
  procedure_document_id: string | null;

  status: HoumonCarePlanStatus;
  created_at?: string;
  updated_at?: string;
  created_by?: string | null;
}

/** 一覧表示用の軽量サマリ */
export interface HoumonCarePlanSummary {
  id: string;
  plan_kind: HoumonPlanKind;
  plan_date: string;
  valid_from: string | null;
  valid_until: string | null;
  author_name: string | null;
  user_consent_date: string | null;
  /** この計画書から作成した手順書 (kaigo_visit_procedure_documents.id) */
  procedure_document_id: string | null;
  status: HoumonCarePlanStatus;
  created_at: string;
  updated_at: string;
}

/** 一覧 select 用の列並び (page.tsx と queries.ts で共有) */
export const HOUMON_CARE_PLAN_SUMMARY_COLUMNS =
  "id, plan_kind, plan_date, valid_from, valid_until, author_name, user_consent_date, procedure_document_id, status, created_at, updated_at";

/** 空の ニーズ・目標 1 行 */
export function emptyGoalRow(): HoumonGoalRow {
  return {
    needs: "",
    long_term_goal: "",
    long_term_period: "",
    short_term_goal: "",
    short_term_period: "",
  };
}

/** 空の 週間サービス 1 行 */
export function emptyWeeklyServiceRow(): WeeklyServiceRow {
  return { days: [], start_time: "", end_time: "", service_kind: "", content: "", notes: "" };
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
    plan_kind: "初回",
    plan_date: dateStr,
    initial_plan_date: dateStr,
    valid_from: dateStr,
    valid_until: null,
    author_name: "",
    creator_name: "",
    user_intention: "",
    family_intention: "",
    basic_policy: "",
    user_situation: "",
    family_situation: "",
    goals: [emptyGoalRow()],
    weekly_services: [emptyWeeklyServiceRow()],
    precautions: "",
    emergency_response: "",
    special_notes: "",
    explained_on: null,
    user_consent_date: null,
    user_consent_name: "",
    consent_proxy_name: "",
    consent_proxy_relation: "",
    source_care_plan_doc_id: null,
    conference_id: null,
    procedure_document_id: null,
    status: "draft",
  };
}

/** 曜日配列 → "月・水・金" 表示 (WEEKDAY_KEYS の並び順に正規化) */
export function formatDays(days: WeekdayKey[]): string {
  const set = new Set(days);
  const picked = WEEKDAY_KEYS.filter((d) => set.has(d));
  if (picked.length === 0) return "";
  if (picked.length === 7) return "毎日";
  return picked.map((d) => WEEKDAY_LABELS[d]).join("・");
}
