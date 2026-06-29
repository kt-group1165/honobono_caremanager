/**
 * 重要事項説明書 / 契約書 管理 — Supabase queries
 *
 * silent failure 防止のため、すべて { error } を check して throw する。
 * 呼出側で try/catch + toast.error で UI 表示すること。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { UserContract, UserContractInput } from "./types";

/**
 * 利用者の契約書一覧を新しい順 (= issued_date desc → created_at desc) で取得
 */
export async function getContractsByUser(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserContract[]> {
  const { data, error } = await supabase
    .from("kaigo_user_contracts")
    .select("*")
    .eq("user_id", userId)
    .order("issued_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as UserContract[];
}

/**
 * 単一契約書を取得 (= 詳細 / 印刷プレビュー画面用)
 */
export async function getContract(
  supabase: SupabaseClient,
  id: string,
): Promise<UserContract | null> {
  const { data, error } = await supabase
    .from("kaigo_user_contracts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as UserContract | null;
}

/**
 * 契約書 INSERT or UPDATE
 *  - input.id 有 → UPDATE
 *  - input.id 無 → INSERT (返却された id を取得)
 *
 * 戻り値: 保存後の row id
 */
export async function saveContract(
  supabase: SupabaseClient,
  input: UserContractInput,
): Promise<string> {
  const payload = {
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    office_id: input.office_id,
    contract_type: input.contract_type,
    business_type: input.business_type,
    issued_date: input.issued_date,
    effective_from: input.effective_from,
    effective_until: input.effective_until,
    signed_at: input.signed_at,
    signed_by_name: input.signed_by_name,
    signed_by_relation: input.signed_by_relation,
    content: input.content ?? {},
    attachment_url: input.attachment_url,
    status: input.status,
    notes: input.notes,
  };

  if (input.id) {
    const { error } = await supabase
      .from("kaigo_user_contracts")
      .update(payload)
      .eq("id", input.id);
    if (error) throw error;
    return input.id;
  }

  const { data, error } = await supabase
    .from("kaigo_user_contracts")
    .insert(payload)
    .select("id")
    .single();
  if (error) throw error;
  const row = data as { id: string } | null;
  if (!row?.id) throw new Error("INSERT で id を取得できませんでした");
  return row.id;
}

/**
 * 契約書を削除
 */
export async function deleteContract(
  supabase: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await supabase
    .from("kaigo_user_contracts")
    .delete()
    .eq("id", id);
  if (error) throw error;
}
