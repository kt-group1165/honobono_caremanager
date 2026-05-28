/**
 * 訪問介護 手順書/モジュール 機能の型定義
 *
 * Phase 1:
 * - 利用者DB 未連携 (client_name は自由入力テキスト)
 * - 訪問介護モードのみで表示
 * - サービス区分は hardcode 11 enum
 */

export const VISIT_SERVICE_KINDS = [
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
] as const;

export type VisitServiceKind = (typeof VISIT_SERVICE_KINDS)[number];

/** 週次表の曜日キー (mon=月 〜 sun=日) */
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

/** サービス番号 (1〜5) */
export const SERVICE_NOS = [1, 2, 3, 4, 5] as const;
export type ServiceNo = (typeof SERVICE_NOS)[number];

/**
 * 週次表 1 セルの値
 * (Excel ④ では「時間帯 + サービス区分」が並列して入る)
 */
export interface WeeklyCell {
  time_range?: string;
  service_kind?: VisitServiceKind | "";
}

/**
 * 週次表 全体
 * { mon: { '1': { time_range, service_kind }, ... }, tue: {}, ... }
 */
export type WeeklySchedule = {
  [K in WeekdayKey]?: {
    [serviceNo: string]: WeeklyCell;
  };
};

export interface VisitProcedureStep {
  id?: string;
  service_id?: string;
  step_no: number;
  content: string;
  minutes: number;
  detail: string | null;
}

export interface VisitProcedureService {
  id?: string;
  document_id?: string;
  service_no: number;
  time_range: string | null;
  service_kind: VisitServiceKind | "";
  special_notes: string | null;
  steps: VisitProcedureStep[];
}

export interface VisitProcedureDocument {
  id?: string;
  tenant_id: string;
  office_id: string | null;
  client_name: string;
  plan_start_date: string; // YYYY-MM-DD
  plan_end_date: string | null; // YYYY-MM-DD
  author_name: string | null;
  creation_reason: string | null;
  special_notes: string | null;
  weekly_schedule: WeeklySchedule;
  created_at?: string;
  updated_at?: string;
  created_by?: string | null;
  services: VisitProcedureService[];
}

/** バージョン一覧画面で使う軽量サマリ */
export interface VisitProcedureDocumentSummary {
  id: string;
  client_name: string;
  plan_start_date: string;
  plan_end_date: string | null;
  author_name: string | null;
  creation_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** 利用者一覧 (DISTINCT client_name + 集計) */
export interface VisitProcedureClient {
  client_name: string;
  version_count: number;
  latest_plan_start_date: string;
}

/** 空の document を返す */
export function emptyDocument(tenantId: string, officeId: string | null): VisitProcedureDocument {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  return {
    tenant_id: tenantId,
    office_id: officeId,
    client_name: "",
    plan_start_date: `${yyyy}-${mm}-${dd}`,
    plan_end_date: null,
    author_name: "",
    creation_reason: "",
    special_notes: "",
    weekly_schedule: {},
    services: SERVICE_NOS.map<VisitProcedureService>((no) => ({
      service_no: no,
      time_range: "",
      service_kind: "",
      special_notes: "",
      steps: [],
    })),
  };
}
