/**
 * 加算管理 Supabase queries
 *
 * 対象 table: kaigo_billing_addons
 *
 * silent failure 防止のため必ず { error } を check し、エラーは throw する。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AddonBusinessType,
  BillingAddon,
  BillingAddonInsert,
  BillingAddonUpdate,
} from "./types";

// PostgREST 1000 行制限対応 (project_pagination_audit_remaining.md)
const PAGE_LIMIT = 1000;

/**
 * 指定 office + business_type の加算一覧 (= 算定開始日 降順 → 加算コード 昇順)
 *
 * 1 office で居宅 / 訪問 兼業のケースは business_type で絞り込み。
 */
export async function getAddons(
  supabase: SupabaseClient,
  officeId: string,
  businessType: AddonBusinessType,
): Promise<BillingAddon[]> {
  const all: BillingAddon[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("kaigo_billing_addons")
      .select("*")
      .eq("office_id", officeId)
      .eq("business_type", businessType)
      .order("applied_from", { ascending: false })
      .order("addon_code", { ascending: true })
      .range(from, from + PAGE_LIMIT - 1);
    if (error) throw error;
    const rows = (data ?? []) as BillingAddon[];
    all.push(...rows);
    if (rows.length < PAGE_LIMIT) break;
    from += PAGE_LIMIT;
  }
  return all;
}

/**
 * 加算 新規作成
 *  - UNIQUE (office_id, addon_code, applied_from) 違反は専用メッセージ
 *  - 戻り値: 新 row
 */
export async function createAddon(
  supabase: SupabaseClient,
  payload: BillingAddonInsert,
): Promise<BillingAddon> {
  const { data, error } = await supabase
    .from("kaigo_billing_addons")
    .insert(payload)
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      throw new Error(
        `同じ加算 (${payload.addon_code}) が同じ算定開始日 (${payload.applied_from}) で既に登録されています`,
      );
    }
    throw error;
  }
  return data as BillingAddon;
}

/**
 * 加算 部分更新
 *  - patch に含めた列のみ更新
 *  - UNIQUE 違反は専用メッセージ
 */
export async function updateAddon(
  supabase: SupabaseClient,
  id: string,
  patch: BillingAddonUpdate,
): Promise<BillingAddon> {
  const { data, error } = await supabase
    .from("kaigo_billing_addons")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      throw new Error(
        `同じ加算が同じ算定開始日で既に登録されています (${patch.addon_code ?? ""} / ${patch.applied_from ?? ""})`,
      );
    }
    throw error;
  }
  return data as BillingAddon;
}

/**
 * 加算 hard delete
 */
export async function deleteAddon(
  supabase: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await supabase
    .from("kaigo_billing_addons")
    .delete()
    .eq("id", id);
  if (error) throw error;
}
