/**
 * 訪問介護 手順書/モジュール 機能の型定義 v2 (2026-06-22 確定)
 *
 * v2 変更点:
 *  - サービス側の time_range を廃止 (= 週次表に移動)
 *  - 週次表は曜日 → 行配列 → サービス番号 → { start: "HH:MM" } | null
 *  - end は start + sum(step.minutes) で UI 側自動算出 (DB 保存なし)
 *  - 実施曜日 chip は廃止 (週次表で完結)
 *
 * Phase 1:
 *  - 利用者DB 未連携 (client_name は自由入力テキスト)
 *  - 訪問介護モードのみで表示
 *  - サービス区分は hardcode 11 enum
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
 * 週次表 1 セルの値 (v2)
 *   - start: "HH:MM" (5 分刻み)
 *   - end は start + サービスの step 合計分から計算 (DB 保存なし)
 *   - null は「この行の このサービス列は空」
 */
export interface WeeklyCell {
  start?: string;
}

/**
 * 週次表 1 日 = 1 行ぶん (= サービス1〜5 の cell 配列)
 *   { '1': { start }, '2': null, ... }
 */
export type WeeklyRow = {
  [serviceNo: string]: WeeklyCell | null;
};

/**
 * 週次表 全体 (v2)
 *   { mon: [row, row, ...], tue: [row, ...], ... }
 *   各曜日 最低 1 行は保持 (空でも)
 */
export type WeeklySchedule = {
  [K in WeekdayKey]?: WeeklyRow[];
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

/** 全曜日に空セル 1 行を入れた weekly_schedule を返す helper */
export function emptyWeeklySchedule(): WeeklySchedule {
  const out: WeeklySchedule = {};
  for (const day of WEEKDAY_KEYS) {
    out[day] = [emptyWeeklyRow()];
  }
  return out;
}

/** サービス 1〜5 が全部 null の 1 行 */
export function emptyWeeklyRow(): WeeklyRow {
  const row: WeeklyRow = {};
  for (const no of SERVICE_NOS) row[String(no)] = null;
  return row;
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
    weekly_schedule: emptyWeeklySchedule(),
    services: SERVICE_NOS.map<VisitProcedureService>((no) => ({
      service_no: no,
      service_kind: "",
      special_notes: "",
      steps: [],
    })),
  };
}

// ─────────────────────────────────────────────────────
// 時刻計算 helper (週次表 end 自動算出用)
// ─────────────────────────────────────────────────────

/** "HH:MM" → 分数 (= 0:00 起算)。parse 不能なら null */
export function parseHHMM(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
  return h * 60 + mi;
}

/**
 * 分数 → "HH:MM" 表記。
 * 24:00 を超える場合は 25:00, 26:00 ... のように 24+ 表記 (= スタート曜日に紐付け)
 */
export function formatHHMM(totalMinutes: number): string {
  const m = Math.max(0, Math.floor(totalMinutes));
  const h = Math.floor(m / 60);
  const mi = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

/** サービスの step 合計分 (= 終了時刻計算用) */
export function sumServiceMinutes(service: VisitProcedureService | undefined | null): number {
  if (!service) return 0;
  let total = 0;
  for (const st of service.steps) {
    const m = Number(st.minutes);
    if (Number.isFinite(m) && m > 0) total += Math.floor(m);
  }
  return total;
}

/** 開始時刻 時プルダウン用 options (0 〜 23) */
export const WEEKLY_HOUR_OPTIONS: readonly number[] = Array.from({ length: 24 }, (_, i) => i);

/** 開始時刻 分プルダウン用 options (0 / 5 / 10 / ... / 55) */
export const WEEKLY_MINUTE_OPTIONS: readonly number[] = Array.from({ length: 12 }, (_, i) => i * 5);

/** step 所要時間プルダウン options (5 分刻み、上限を引数指定) */
export function buildStepDurationOptions(maxMinutes: number): number[] {
  const max = Math.max(5, Math.floor(maxMinutes / 5) * 5);
  const out: number[] = [];
  for (let m = 5; m <= max; m += 5) out.push(m);
  return out;
}

// ─────────────────────────────────────────────────────
// step テンプレート (= サービス内容 + 具体的取り組内容 の master)
// 2026-06-22 user 確定
// ─────────────────────────────────────────────────────

/**
 * 訪問介護手順書 step テンプレート (office ごと)
 *  - name (= サービス内容) + detail (= 具体的取り組内容) の 2 フィールド
 *  - 時間は登録しない (= 各 step 行で毎回手入力)
 *  - 既存手順書とは独立 (= テキスト一致のみ、FK 参照なし)
 *  - soft delete (= deleted_at) で履歴保持
 */
/**
 * テンプレート カテゴリ (= 事前定義 enum 11)
 * 2026-06-24 user 確定。DB schema の CHECK 制約とも一致させる。
 */
export const STEP_TEMPLATE_CATEGORIES = [
  "挨拶・確認",
  "バイタル",
  "排泄",
  "入浴",
  "食事",
  "服薬",
  "移乗・歩行",
  "掃除・洗濯",
  "買物・通院",
  "記録",
  "その他",
] as const;

export type StepTemplateCategory = (typeof STEP_TEMPLATE_CATEGORIES)[number];

export interface VisitProcedureStepTemplate {
  id: string;
  office_id: string;
  tenant_id: string;
  name: string;
  detail: string | null;
  category: StepTemplateCategory;
  sort_order: number;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}
