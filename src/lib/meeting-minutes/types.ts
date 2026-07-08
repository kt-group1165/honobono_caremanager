/**
 * サービス担当者会議の要点（第4表） 型定義
 *
 * 厚労省標準様式 第4表 に準拠。
 *
 * 保存先 table: kaigo_report_documents
 *   - report_type = "meeting-minutes"
 *   - content jsonb に下記 MeetingContent を格納
 *
 * 注意:
 *  - "use client" boundary を跨ぐ型は本 module に集約 (memory: feedback_use_client_const_export.md)
 *  - 後方互換のため content は legacy 形 (= 固定 9 名 attendees) も受け付ける
 *    → emptyContent() で正規化し UI 側で扱う
 */

export const REPORT_TYPE = "meeting-minutes" as const;

/** 出席者 1 名 (= 所属/職種 + 氏名) */
export interface Attendee {
  /** 所属(職種) 例: 訪問介護事業所 / 通所介護事業所 サ責 */
  affiliation: string;
  /** 氏名 */
  name: string;
}

/** 第4表 content (kaigo_report_documents.content) */
export interface MeetingContent {
  /** 開催日 YYYY-MM-DD */
  meeting_date: string;
  /** 開催場所 */
  location: string;
  /** 開催時間 例: 14:00〜15:30 */
  time_range: string;
  /** 開催回数 例: 第1回 */
  session_number: string;
  /** 居宅サービス計画作成者（担当者）氏名 = ケアマネ氏名 */
  creator_name: string;
  /** 出席者一覧 (= 0〜N 名、可変) */
  attendees: Attendee[];
  /** 利用者本人の出席有無 */
  self_attended: boolean;
  /** 家族の出席有無 */
  family_attended: boolean;
  /** 家族の続柄 */
  family_relationship: string;
  /** 備考 */
  remarks: string;
  /** 検討した項目 (= 複数行 OK の自由テキスト) */
  topics: string;
  /** 検討内容 */
  discussion: string;
  /** 結論 */
  conclusion: string;
  /** 残された課題（次回の開催時期） */
  remaining_issues: string;
  // ─ 利用者基本情報の snapshot (= 保存時点の認定情報、印刷で使う)
  /** 介護度 (保存時の snapshot) 例: 要介護2 */
  care_level_snapshot?: string;
  /** 認定有効期間 開始 YYYY-MM-DD */
  certification_start_snapshot?: string;
  /** 認定有効期間 終了 YYYY-MM-DD */
  certification_end_snapshot?: string;
}

/** kaigo_report_documents の row (= 会議録) */
export interface MeetingDoc {
  id: string;
  user_id: string;
  care_plan_id: string | null;
  report_type: typeof REPORT_TYPE;
  title: string;
  content: MeetingContent;
  status: "draft" | "completed";
  updated_at: string;
}

/** UserSidebar 連動用の最小利用者表現 (共有マスタ clients の subset。かな列は furigana) */
export interface KaigoUserLite {
  id: string;
  name: string;
  furigana: string | null;
}

/** 計画期間 tab に表示する ケアプラン要約 */
export interface CarePlanSummary {
  id: string;
  plan_number: string | null;
  plan_type: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string;
}

/** 認定情報の snapshot (= 最新の認定 1 件、無ければ null) */
export interface CertificationLite {
  care_level: string | null;
  certification_start_date: string | null;
  certification_end_date: string | null;
}

/** 空 attendee */
export const emptyAttendee = (): Attendee => ({ affiliation: "", name: "" });

/**
 * 空 MeetingContent (= 新規作成時の初期値)
 *
 * attendees は最低限の枠として 6 行 (= 一般的な担当者会議の出席者数) を初期表示。
 * UI で追加/削除可能。
 */
export function emptyContent(meetingDate?: string): MeetingContent {
  return {
    meeting_date: meetingDate ?? new Date().toISOString().slice(0, 10),
    location: "",
    time_range: "",
    session_number: "",
    creator_name: "",
    attendees: Array.from({ length: 6 }, () => emptyAttendee()),
    self_attended: false,
    family_attended: false,
    family_relationship: "",
    remarks: "",
    topics: "",
    discussion: "",
    conclusion: "",
    remaining_issues: "",
  };
}

/**
 * legacy/不整合データを正規化 (= UI 表示前に通す)
 *
 *  - attendees が array でなければ空配列に
 *  - 旧 9 行固定の seed (= 末尾に空 attendee が多数) はそのまま保持して編集可能に
 *  - 必須フィールドの undefined は emptyContent() からの default で埋める
 */
export function normalizeContent(input: Partial<MeetingContent> | null | undefined): MeetingContent {
  const base = emptyContent();
  const merged: MeetingContent = { ...base, ...(input ?? {}) };
  if (!Array.isArray(merged.attendees)) {
    merged.attendees = [];
  } else {
    merged.attendees = merged.attendees.map((a) => ({
      affiliation: typeof a?.affiliation === "string" ? a.affiliation : "",
      name: typeof a?.name === "string" ? a.name : "",
    }));
  }
  return merged;
}
