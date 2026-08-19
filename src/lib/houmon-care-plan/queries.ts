/**
 * 訪問介護計画書 (kaigo_houmon_care_plans) の Supabase queries v2
 *
 * silent failure 防止: 全 query で `{ error }` を check し、throw する。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  emptyGoalRow,
  emptyWeeklyServiceRow,
  HOUMON_CARE_PLAN_SUMMARY_COLUMNS,
  HOUMON_PLAN_KINDS,
  WEEKDAY_KEYS,
  type HoumonCarePlan,
  type HoumonCarePlanSummary,
  type HoumonGoalRow,
  type HoumonPlanKind,
  type VisitCareServiceKind,
  type WeekdayKey,
  type WeeklyServiceRow,
} from "./types";

const TABLE = "kaigo_houmon_care_plans";

/** migration (houmon_care_plans_v2.sql) 未適用を判定する */
export function isSchemaV1Error(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  // PostgREST: 未知の列は 42703 / スキーマキャッシュ不一致は PGRST204
  if (e.code === "42703" || e.code === "PGRST204") return true;
  return /goals|weekly_services|plan_kind/.test(e.message ?? "") && /column/i.test(e.message ?? "");
}

/** 1 user の計画一覧 (= 新しい計画日順) */
export async function getPlansByUser(
  supabase: SupabaseClient,
  userId: string,
): Promise<HoumonCarePlanSummary[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select(HOUMON_CARE_PLAN_SUMMARY_COLUMNS)
    .eq("user_id", userId)
    .order("plan_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as HoumonCarePlanSummary[];
}

// ── JSONB の正規化 ─────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function normalizeGoals(raw: unknown): HoumonGoalRow[] {
  if (!Array.isArray(raw)) return [emptyGoalRow()];
  const out: HoumonGoalRow[] = [];
  for (const item of raw) {
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      out.push({
        needs: str(o.needs),
        long_term_goal: str(o.long_term_goal),
        long_term_period: str(o.long_term_period),
        short_term_goal: str(o.short_term_goal),
        short_term_period: str(o.short_term_period),
      });
    }
  }
  return out.length > 0 ? out : [emptyGoalRow()];
}

function normalizeDays(raw: unknown): WeekdayKey[] {
  if (!Array.isArray(raw)) return [];
  const valid = new Set<string>(WEEKDAY_KEYS);
  const set = new Set(raw.filter((d): d is string => typeof d === "string" && valid.has(d)));
  return WEEKDAY_KEYS.filter((d) => set.has(d));
}

function normalizeWeeklyServices(raw: unknown): WeeklyServiceRow[] {
  if (!Array.isArray(raw)) return [emptyWeeklyServiceRow()];
  const out: WeeklyServiceRow[] = [];
  for (const item of raw) {
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      out.push({
        days: normalizeDays(o.days),
        start_time: str(o.start_time),
        end_time: str(o.end_time),
        service_kind: str(o.service_kind) as VisitCareServiceKind | "",
        content: str(o.content),
        notes: str(o.notes),
      });
    }
  }
  return out.length > 0 ? out : [emptyWeeklyServiceRow()];
}

function normalizePlanKind(raw: unknown): HoumonPlanKind {
  const s = str(raw) as HoumonPlanKind;
  return (HOUMON_PLAN_KINDS as readonly string[]).includes(s) ? s : "初回";
}

/** 単一 plan を取得 (= 編集 / 印刷 view 用) */
export async function getPlan(
  supabase: SupabaseClient,
  id: string,
): Promise<HoumonCarePlan | null> {
  const { data, error } = await supabase.from(TABLE).select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    id: str(row.id),
    tenant_id: str(row.tenant_id),
    user_id: str(row.user_id),
    office_id: (row.office_id as string | null) ?? null,
    plan_kind: normalizePlanKind(row.plan_kind),
    plan_date: str(row.plan_date),
    initial_plan_date: (row.initial_plan_date as string | null) ?? null,
    valid_from: (row.valid_from as string | null) ?? null,
    valid_until: (row.valid_until as string | null) ?? null,
    author_name: str(row.author_name),
    creator_name: str(row.creator_name),
    user_intention: str(row.user_intention),
    family_intention: str(row.family_intention),
    basic_policy: str(row.basic_policy),
    user_situation: str(row.user_situation),
    family_situation: str(row.family_situation),
    goals: normalizeGoals(row.goals),
    weekly_services: normalizeWeeklyServices(row.weekly_services),
    precautions: str(row.precautions),
    emergency_response: str(row.emergency_response),
    special_notes: str(row.special_notes),
    explained_on: (row.explained_on as string | null) ?? null,
    user_consent_date: (row.user_consent_date as string | null) ?? null,
    user_consent_name: str(row.user_consent_name),
    consent_proxy_name: str(row.consent_proxy_name),
    consent_proxy_relation: str(row.consent_proxy_relation),
    source_care_plan_doc_id: (row.source_care_plan_doc_id as string | null) ?? null,
    conference_id: (row.conference_id as string | null) ?? null,
    procedure_document_id: (row.procedure_document_id as string | null) ?? null,
    status: row.status === "completed" ? "completed" : "draft",
    created_at: (row.created_at as string) ?? undefined,
    updated_at: (row.updated_at as string) ?? undefined,
    created_by: (row.created_by as string | null) ?? null,
  };
}

/** 空行を落として保存対象だけにする (= 空 row が印刷様式に出るのを防ぐ) */
function compactGoals(rows: HoumonGoalRow[]): HoumonGoalRow[] {
  return rows.filter(
    (g) =>
      g.needs.trim() ||
      g.long_term_goal.trim() ||
      g.short_term_goal.trim() ||
      g.long_term_period.trim() ||
      g.short_term_period.trim(),
  );
}

function compactWeeklyServices(rows: WeeklyServiceRow[]): WeeklyServiceRow[] {
  return rows.filter(
    (s) =>
      s.days.length > 0 ||
      s.start_time.trim() ||
      s.end_time.trim() ||
      s.service_kind ||
      s.content.trim() ||
      s.notes.trim(),
  );
}

/** INSERT or UPDATE。戻り値は plan の id */
export async function savePlan(
  supabase: SupabaseClient,
  plan: HoumonCarePlan,
): Promise<string> {
  const payload = {
    tenant_id: plan.tenant_id,
    user_id: plan.user_id,
    office_id: plan.office_id,
    plan_kind: plan.plan_kind,
    plan_date: plan.plan_date,
    initial_plan_date: plan.initial_plan_date,
    valid_from: plan.valid_from,
    valid_until: plan.valid_until,
    author_name: plan.author_name || null,
    creator_name: plan.creator_name || null,
    user_intention: plan.user_intention || null,
    family_intention: plan.family_intention || null,
    basic_policy: plan.basic_policy || null,
    user_situation: plan.user_situation || null,
    family_situation: plan.family_situation || null,
    goals: compactGoals(plan.goals),
    weekly_services: compactWeeklyServices(plan.weekly_services),
    precautions: plan.precautions || null,
    emergency_response: plan.emergency_response || null,
    special_notes: plan.special_notes || null,
    explained_on: plan.explained_on,
    user_consent_date: plan.user_consent_date,
    user_consent_name: plan.user_consent_name || null,
    consent_proxy_name: plan.consent_proxy_name || null,
    consent_proxy_relation: plan.consent_proxy_relation || null,
    source_care_plan_doc_id: plan.source_care_plan_doc_id,
    conference_id: plan.conference_id,
    procedure_document_id: plan.procedure_document_id,
    status: plan.status,
  };
  if (plan.id) {
    const { error } = await supabase.from(TABLE).update(payload).eq("id", plan.id);
    if (error) throw error;
    return plan.id;
  }
  const { data, error } = await supabase.from(TABLE).insert(payload).select("id").single();
  if (error) throw error;
  return (data as { id: string }).id;
}

/**
 * 計画書を物理削除 (= soft delete 列が無いので hard delete)
 */
export async function softDeletePlan(supabase: SupabaseClient, id: string): Promise<void> {
  const { error } = await supabase.from(TABLE).delete().eq("id", id);
  if (error) throw error;
}

/**
 * 既存 plan を複製して新しいバージョンを作る (ほのぼの Q-4「既存の計画書を複写」相当)
 *  - plan_date は引数で上書き / status は draft に戻す
 *  - 作成区分は「変更」、初回作成日は複製元を引き継ぐ
 *  - 同意・説明日は引き継がない (= 新しい版で取り直すため)
 */
export async function duplicatePlan(
  supabase: SupabaseClient,
  sourceId: string,
  newPlanDate: string,
): Promise<string> {
  const src = await getPlan(supabase, sourceId);
  if (!src) throw new Error("複製元の計画書が見つかりません");
  const clone: HoumonCarePlan = {
    ...src,
    id: undefined,
    plan_kind: "変更",
    plan_date: newPlanDate,
    initial_plan_date: src.initial_plan_date ?? src.plan_date,
    valid_from: newPlanDate,
    valid_until: null,
    status: "draft",
    goals: src.goals.map((g) => ({ ...g })),
    weekly_services: src.weekly_services.map((s) => ({ ...s, days: [...s.days] })),
    explained_on: null,
    user_consent_date: null,
    user_consent_name: "",
    consent_proxy_name: "",
    consent_proxy_relation: "",
    procedure_document_id: null,
  };
  return savePlan(supabase, clone);
}

// ─────────────────────────────────────────────────────────────────────────────
// 居宅サービス計画書 / アセスメント からの取込
//   ほのぼの: 「同一事業所内で居宅があり、かつ ほのぼのシステムをご利用の場合、
//              ボタンを押すことで同内容を取り込むことができます」
//   → こちらは同一 DB なので居宅側 (kaigo_report_documents / kaigo_assessments) を直接引ける
// ─────────────────────────────────────────────────────────────────────────────

/** 第2表の needs_blocks 構造 (reports/[type] の NeedsBlock と同形) */
interface NeedsBlock {
  needs?: unknown;
  long_term_goal?: unknown;
  long_term_period?: unknown;
  goals?: unknown;
}

/** 居宅 第2表 の needs_blocks → 訪問介護計画書の goals[] へ平坦化 */
export function flattenNeedsBlocks(raw: unknown): HoumonGoalRow[] {
  if (!Array.isArray(raw)) return [];
  const out: HoumonGoalRow[] = [];
  for (const b of raw as NeedsBlock[]) {
    if (!b || typeof b !== "object") continue;
    const needs = str(b.needs);
    const ltGoal = str(b.long_term_goal);
    const ltPeriod = str(b.long_term_period);
    const goals = Array.isArray(b.goals) ? b.goals : [];
    if (goals.length === 0) {
      out.push({
        needs,
        long_term_goal: ltGoal,
        long_term_period: ltPeriod,
        short_term_goal: "",
        short_term_period: "",
      });
      continue;
    }
    for (const g of goals) {
      const go = (g ?? {}) as Record<string, unknown>;
      out.push({
        needs,
        long_term_goal: ltGoal,
        long_term_period: ltPeriod,
        short_term_goal: str(go.short_term_goal),
        short_term_period: str(go.short_term_period),
      });
    }
  }
  return out;
}

export interface CarePlanImportResult {
  /** 取込に成功した項目の patch (= 空文字の項目は含めない) */
  patch: Partial<HoumonCarePlan>;
  /** 取込元の説明 (toast 表示用) */
  sources: string[];
}

/**
 * 居宅サービス計画書 (第1表/第2表) + アセスメント から取り込める内容を集める。
 *
 * - 第1表 (care-plan-1): 総合的な援助の方針 → 援助の基本方針
 * - 第2表 (care-plan-2): needs_blocks → ニーズ・長期目標・短期目標 (期間つき)
 * - アセスメント: 本人の要望 → 本人の意向 / 家族の要望 → 家族の意向 / 家族の状況
 *
 * 取れなかった項目は patch に含めないので、呼び出し側で既存値を潰さない。
 */
export async function fetchCarePlanImport(
  supabase: SupabaseClient,
  userId: string,
): Promise<CarePlanImportResult> {
  const [plan1Res, plan2Res, assessRes] = await Promise.all([
    supabase
      .from("kaigo_report_documents")
      .select("id, content, updated_at")
      .eq("user_id", userId)
      .eq("report_type", "care-plan-1")
      .order("updated_at", { ascending: false })
      .limit(1),
    supabase
      .from("kaigo_report_documents")
      .select("id, content, updated_at")
      .eq("user_id", userId)
      .eq("report_type", "care-plan-2")
      .order("updated_at", { ascending: false })
      .limit(1),
    supabase
      .from("kaigo_assessments")
      .select("user_request, family_request, family_situation, overall_summary, assessment_date")
      .eq("user_id", userId)
      .order("assessment_date", { ascending: false, nullsFirst: false })
      .limit(1),
  ]);

  if (plan1Res.error) throw plan1Res.error;
  if (plan2Res.error) throw plan2Res.error;
  if (assessRes.error) throw assessRes.error;

  const patch: Partial<HoumonCarePlan> = {};
  const sources: string[] = [];

  const doc1 = plan1Res.data?.[0];
  if (doc1) {
    const c = (doc1.content ?? {}) as Record<string, unknown>;
    const policy = str(c.overall_policy);
    if (policy) {
      patch.basic_policy = policy;
      patch.source_care_plan_doc_id = doc1.id as string;
      sources.push("第1表 (総合的な援助の方針)");
    }
  }

  const doc2 = plan2Res.data?.[0];
  if (doc2) {
    const c = (doc2.content ?? {}) as Record<string, unknown>;
    const rawBlocks = Array.isArray(c.needs_blocks)
      ? c.needs_blocks
      : Array.isArray(c.blocks)
        ? c.blocks
        : null;
    const rows = flattenNeedsBlocks(rawBlocks);
    if (rows.length > 0) {
      patch.goals = rows;
      patch.source_care_plan_doc_id = patch.source_care_plan_doc_id ?? (doc2.id as string);
      sources.push(`第2表 (課題・目標 ${rows.length}件)`);
    }
  }

  const assess = assessRes.data?.[0] as
    | {
        user_request: string | null;
        family_request: string | null;
        family_situation: string | null;
      }
    | undefined;
  if (assess) {
    const picked: string[] = [];
    if (assess.user_request) {
      patch.user_intention = assess.user_request;
      picked.push("本人の意向");
    }
    if (assess.family_request) {
      patch.family_intention = assess.family_request;
      picked.push("家族の意向");
    }
    if (assess.family_situation) {
      patch.family_situation = assess.family_situation;
      picked.push("家族の状況");
    }
    if (picked.length > 0) sources.push(`アセスメント (${picked.join("・")})`);
  }

  return { patch, sources };
}

/** 直近のカンファレンス記録 (= 計画作成の根拠として紐付ける) */
export interface ConferenceRef {
  id: string;
  held_on: string;
  agenda: string | null;
  conclusion: string | null;
}

export async function getRecentConferences(
  supabase: SupabaseClient,
  userId: string,
  limit = 5,
): Promise<ConferenceRef[]> {
  const { data, error } = await supabase
    .from("kaigo_care_conferences")
    .select("id, held_on, agenda, conclusion")
    .eq("client_id", userId)
    .order("held_on", { ascending: false })
    .limit(limit);
  if (error) {
    // カンファレンス table 未作成 (migration 未適用) でも計画書は使えるようにする
    if (error.code === "42P01" || error.code === "PGRST205") return [];
    throw error;
  }
  return (data ?? []) as ConferenceRef[];
}
