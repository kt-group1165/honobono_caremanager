/**
 * 訪問介護計画書 → 手順書 (個別援助詳細計画) への引き継ぎ
 *
 * ほのぼの NEXT「訪問介護計画書作成編」Ⅱ-2:
 *   「作成した訪問介護計画書をもとに詳細のサービス手順書、実施記録表を作成します」
 *
 * 計画書の週間サービス計画 (weekly_services) を手順書のサービス + 週次表に写す。
 * step は「援助内容を 1 step」として起こすだけ (= 手順の分解は手順書側で行う)。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { saveDocument } from "@/lib/visit-procedure/queries";
import {
  emptyDocument,
  emptyWeeklyRow,
  parseHHMM,
  SERVICE_NOS,
  VISIT_SERVICE_KINDS,
  type VisitProcedureDocument,
  type VisitProcedureService,
  type VisitServiceKind,
  type WeeklyRow,
  type WeeklySchedule,
} from "@/lib/visit-procedure/types";
import { formatDays, type HoumonCarePlan, type WeeklyServiceRow } from "./types";

/** 手順書が扱えるサービス区分か (= 通院等乗降介助 は手順書側の enum に無い) */
function toProcedureKind(kind: string): VisitServiceKind | "" {
  return (VISIT_SERVICE_KINDS as readonly string[]).includes(kind)
    ? (kind as VisitServiceKind)
    : "";
}

/** 開始〜終了から所要時間 (分)。取れなければ 0 */
function durationMinutes(row: WeeklyServiceRow): number {
  const s = parseHHMM(row.start_time);
  const e = parseHHMM(row.end_time);
  if (s === null || e === null) return 0;
  const diff = e - s;
  return diff > 0 ? diff : 0;
}

/**
 * 引き継ぐ価値がある行だけ残す。
 * 曜日だけの行は手順書側でサービスとして成立しない (= saveDocument に落とされ、
 * 週次表だけが実体の無いサービス番号を指す) ので除外する。
 */
function meaningfulRows(rows: WeeklyServiceRow[]): WeeklyServiceRow[] {
  return rows.filter((r) => r.service_kind || r.content.trim());
}

export interface PlanToProcedureResult {
  documentId: string;
  /** 手順書は サービス 5 枠までなので、溢れた行数 */
  overflow: number;
  /** 手順書の区分 enum に無く未設定にした行の区分名 (例: 通院等乗降介助) */
  unsupportedKinds: string[];
}

/**
 * 計画書から手順書 document を新規作成する。
 *
 * @param clientName 手順書側の利用者名 (standalone/integrated 共通で必須)
 * @param clientId   integrated モード時のみ渡す clients.id
 */
export async function createProcedureFromPlan(
  supabase: SupabaseClient,
  plan: HoumonCarePlan,
  opts: { clientName: string; clientId: string | null },
): Promise<PlanToProcedureResult> {
  const rows = meaningfulRows(plan.weekly_services);
  if (rows.length === 0) {
    throw new Error("週間サービス計画が空です。先に計画書へサービスを 1 件以上入力してください");
  }

  const maxServices = SERVICE_NOS.length;
  const used = rows.slice(0, maxServices);
  const overflow = rows.length - used.length;
  const unsupportedKinds: string[] = [];

  const doc: VisitProcedureDocument = emptyDocument(plan.tenant_id, plan.office_id);
  doc.client_name = opts.clientName;
  doc.client_id = opts.clientId;
  doc.plan_start_date = plan.valid_from ?? plan.plan_date;
  doc.plan_end_date = plan.valid_until;
  doc.author_name = plan.author_name || plan.creator_name || "";
  doc.creation_reason = `訪問介護計画書 (${plan.plan_date} / ${plan.plan_kind}) より作成`;
  doc.special_notes = [plan.precautions, plan.emergency_response ? `【緊急時】${plan.emergency_response}` : ""]
    .filter(Boolean)
    .join("\n");

  // ── サービス枠 (1〜5) ──
  const services: VisitProcedureService[] = SERVICE_NOS.map((no) => {
    const row = used[no - 1];
    if (!row) {
      return { service_no: no, service_kind: "", special_notes: "", steps: [] };
    }
    const kind = toProcedureKind(row.service_kind);
    if (row.service_kind && !kind) unsupportedKinds.push(row.service_kind);
    const noteParts = [
      row.days.length > 0 ? `曜日: ${formatDays(row.days)}` : "",
      // 手順書の service_kind は NOT NULL で「身体1」に丸められるため、元の区分を必ず残す
      row.service_kind && !kind
        ? `⚠ 計画書の区分は「${row.service_kind}」。手順書の区分に無いため仮に 身体1 で保存しています。確認してください`
        : "",
      row.notes,
    ].filter(Boolean);
    return {
      service_no: no,
      service_kind: kind,
      special_notes: noteParts.join("\n") || null,
      steps: row.content.trim()
        ? [
            {
              step_no: 1,
              content: row.content.trim(),
              minutes: durationMinutes(row),
              detail: null,
            },
          ]
        : [],
    };
  });
  doc.services = services;

  // ── 週次表 (曜日 → 行 → サービス番号 → 開始時刻) ──
  const schedule: WeeklySchedule = {};
  for (const day of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const) {
    const dayRows: WeeklyRow[] = [];
    used.forEach((row, idx) => {
      if (!row.days.includes(day)) return;
      const cell = emptyWeeklyRow();
      cell[String(idx + 1)] = row.start_time ? { start: row.start_time } : {};
      dayRows.push(cell);
    });
    // 各曜日 最低 1 行は保持する (手順書 UI の前提)
    schedule[day] = dayRows.length > 0 ? dayRows : [emptyWeeklyRow()];
  }
  doc.weekly_schedule = schedule;

  const documentId = await saveDocument(supabase, doc);
  return { documentId, overflow, unsupportedKinds: [...new Set(unsupportedKinds)] };
}

/** 作成した手順書を計画書に紐付ける (= 一覧から「手順書を開く」ため) */
export async function linkProcedureToPlan(
  supabase: SupabaseClient,
  planId: string,
  documentId: string,
): Promise<void> {
  const { error } = await supabase
    .from("kaigo_houmon_care_plans")
    .update({ procedure_document_id: documentId })
    .eq("id", planId);
  if (error) throw error;
}
