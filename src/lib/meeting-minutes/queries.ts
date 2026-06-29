/**
 * サービス担当者会議の要点（第4表） Supabase queries
 *
 * 対象 table: kaigo_report_documents (= report_type = "meeting-minutes")
 *
 * silent failure 防止のため必ず { error } を check し、エラーは throw する。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  REPORT_TYPE,
  type CarePlanSummary,
  type CertificationLite,
  type KaigoUserLite,
  type MeetingContent,
  type MeetingDoc,
  normalizeContent,
} from "./types";

/**
 * 利用者の基本情報 (= UserSidebar の選択 user) を取得。
 */
export async function getUserLite(
  supabase: SupabaseClient,
  userId: string,
): Promise<KaigoUserLite | null> {
  const { data, error } = await supabase
    .from("clients")
    .select("id, name, name_kana")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as KaigoUserLite | null) ?? null;
}

/**
 * 利用者のケアプラン一覧 (= 計画期間 tab 用)。
 * start_date 降順 (= 直近の計画が先頭)。
 */
export async function getCarePlans(
  supabase: SupabaseClient,
  userId: string,
): Promise<CarePlanSummary[]> {
  const { data, error } = await supabase
    .from("kaigo_care_plans")
    .select("id, plan_number, plan_type, start_date, end_date, status")
    .eq("user_id", userId)
    .order("start_date", { ascending: false });
  if (error) throw error;
  return (data ?? []) as CarePlanSummary[];
}

/**
 * 利用者の最新認定情報 (= 介護度 / 認定有効期間) を 1 件取得。
 *
 * client_insurance_records は client_id ベース。
 * 認定済 (= certification_status='認定済み') があれば優先、無ければ certification_start_date 降順の 1 件目。
 */
export async function getLatestCertification(
  supabase: SupabaseClient,
  userId: string,
): Promise<CertificationLite | null> {
  const { data, error } = await supabase
    .from("client_insurance_records")
    .select("care_level, certification_start_date, certification_end_date, certification_status")
    .eq("client_id", userId)
    .order("certification_start_date", { ascending: false, nullsFirst: false });
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    care_level: string | null;
    certification_start_date: string | null;
    certification_end_date: string | null;
    certification_status: string | null;
  }>;
  if (rows.length === 0) return null;
  const preferred = rows.find((r) => r.certification_status === "認定済み") ?? rows[0];
  return {
    care_level: preferred.care_level,
    certification_start_date: preferred.certification_start_date,
    certification_end_date: preferred.certification_end_date,
  };
}

/**
 * 指定利用者の会議録一覧 (= report_type=meeting-minutes)。
 * carePlanId が渡されればその計画期間に紐付くもののみ。
 * 更新日時 降順。
 */
export async function getMeetingDocs(
  supabase: SupabaseClient,
  userId: string,
  carePlanId: string | null,
): Promise<MeetingDoc[]> {
  let q = supabase
    .from("kaigo_report_documents")
    .select("*")
    .eq("user_id", userId)
    .eq("report_type", REPORT_TYPE)
    .order("updated_at", { ascending: false });
  if (carePlanId) q = q.eq("care_plan_id", carePlanId);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as Array<Omit<MeetingDoc, "content"> & { content: unknown }>;
  // content の正規化 (= legacy 形を吸収)
  return rows.map((r) => ({
    ...r,
    content: normalizeContent(r.content as Partial<MeetingContent> | null),
  })) as MeetingDoc[];
}

/**
 * 会議録 新規作成。
 * 返り値: 新 row の id
 */
export async function createMeetingDoc(
  supabase: SupabaseClient,
  payload: {
    user_id: string;
    care_plan_id: string | null;
    title: string;
    content: MeetingContent;
    status: "draft" | "completed";
  },
): Promise<string> {
  const { data, error } = await supabase
    .from("kaigo_report_documents")
    .insert({
      user_id: payload.user_id,
      care_plan_id: payload.care_plan_id,
      report_type: REPORT_TYPE,
      title: payload.title,
      content: payload.content,
      status: payload.status,
    })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

/**
 * 会議録 更新。
 */
export async function updateMeetingDoc(
  supabase: SupabaseClient,
  id: string,
  patch: {
    care_plan_id: string | null;
    title: string;
    content: MeetingContent;
    status: "draft" | "completed";
  },
): Promise<void> {
  const { error } = await supabase
    .from("kaigo_report_documents")
    .update({
      title: patch.title,
      content: patch.content,
      status: patch.status,
      care_plan_id: patch.care_plan_id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw error;
}

/**
 * 会議録 hard delete。
 */
export async function deleteMeetingDoc(
  supabase: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await supabase
    .from("kaigo_report_documents")
    .delete()
    .eq("id", id);
  if (error) throw error;
}
