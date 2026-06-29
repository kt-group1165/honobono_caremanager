/**
 * 訪問介護計画書 (kaigo_houmon_care_plans) の Supabase queries
 *
 * silent failure 防止: 全 query で `{ error }` を check し、throw する。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  emptyVisitCareService,
  type HoumonCarePlan,
  type HoumonCarePlanSummary,
  type VisitCareService,
} from "./types";

const TABLE = "kaigo_houmon_care_plans";

/** 1 user の計画一覧 (= 新しい計画日順) */
export async function getPlansByUser(
  supabase: SupabaseClient,
  userId: string,
): Promise<HoumonCarePlanSummary[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, plan_date, valid_from, valid_until, author_name, status, created_at, updated_at")
    .eq("user_id", userId)
    .order("plan_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as HoumonCarePlanSummary[];
}

/** services JSONB を VisitCareService[] に正規化 (= null/型不正を空 row に揃える) */
function normalizeServices(raw: unknown): VisitCareService[] {
  if (!Array.isArray(raw)) return [emptyVisitCareService()];
  const out: VisitCareService[] = [];
  for (const item of raw) {
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      out.push({
        kind: typeof o.kind === "string" ? (o.kind as VisitCareService["kind"]) : "",
        frequency: typeof o.frequency === "string" ? o.frequency : "",
        time_range: typeof o.time_range === "string" ? o.time_range : "",
        content: typeof o.content === "string" ? o.content : "",
      });
    }
  }
  if (out.length === 0) out.push(emptyVisitCareService());
  return out;
}

/** 単一 plan を取得 (= 編集 / 印刷 view 用) */
export async function getPlan(
  supabase: SupabaseClient,
  id: string,
): Promise<HoumonCarePlan | null> {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as Omit<HoumonCarePlan, "services"> & { services?: unknown };
  return {
    ...row,
    services: normalizeServices(row.services),
  };
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
    plan_date: plan.plan_date,
    valid_from: plan.valid_from,
    valid_until: plan.valid_until,
    long_term_goal: plan.long_term_goal || null,
    short_term_goal: plan.short_term_goal || null,
    user_situation: plan.user_situation || null,
    family_situation: plan.family_situation || null,
    services: plan.services,
    special_notes: plan.special_notes || null,
    author_name: plan.author_name || null,
    user_consent_date: plan.user_consent_date,
    user_consent_name: plan.user_consent_name || null,
    status: plan.status,
  };
  if (plan.id) {
    const { error } = await supabase
      .from(TABLE)
      .update(payload)
      .eq("id", plan.id);
    if (error) throw error;
    return plan.id;
  }
  const { data, error } = await supabase
    .from(TABLE)
    .insert(payload)
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

/**
 * 計画書を物理削除 (= soft delete 列が無いので hard delete)
 * (将来 status='archived' を追加するなら CHECK 制約 + 列追加が要る)
 */
export async function softDeletePlan(
  supabase: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq("id", id);
  if (error) throw error;
}

/**
 * 既存 plan を複製して新しいバージョンを作る
 *  - plan_date は引数で上書き
 *  - status は draft に戻す
 *  - valid_from / valid_until は新しい計画日を起点に再設定
 *  - 戻り値: 新 plan の id
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
    plan_date: newPlanDate,
    valid_from: newPlanDate,
    valid_until: null,
    status: "draft",
    services: src.services.map((s) => ({ ...s })),
  };
  return savePlan(supabase, clone);
}
