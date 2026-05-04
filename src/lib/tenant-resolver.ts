import type { SupabaseClient } from "@supabase/supabase-js";

// 多 tenant 管理者でも決定的に「自分が運用している tenant」を返す共通ヘルパー。
// emergency_tokens / support_tokens のような親無し token 表で、admin が
// 発行する際の tenant_id を解決する。
//
// 優先順位:
//   (1) user_offices.is_primary=true の office の tenant_id（office_admin / member）
//   (2) (1) が無ければ group-type tenant（group_admin の本部、KT Group は 'kt-group'）
//   (3) いずれも無ければ auth_user_admin_tenants() rpc の最初（最終 fallback）
//
// 戻り値:
//   - 成功: tenant_id (TEXT)
//   - 認証情報無し or admin 権限が全く無い場合: null

export type TenantResolveResult =
  | { ok: true; tenantId: string }
  | { ok: false; error: string };

export async function resolvePreferredTenantId(
  supabase: SupabaseClient
): Promise<TenantResolveResult> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "認証情報が取得できません" };
  }

  // (1) primary office の tenant
  const { data: officeRow } = await supabase
    .from("user_offices")
    .select("offices!inner(tenant_id)")
    .eq("user_id", user.id)
    .order("is_primary", { ascending: false })
    .limit(1)
    .maybeSingle();
  const officeTenant = (officeRow as { offices?: { tenant_id?: string } } | null)?.offices?.tenant_id;
  if (officeTenant) return { ok: true, tenantId: officeTenant };

  // (2) group-type tenant（RLS で自分が見えるもののみ返る）
  const { data: groupTenant } = await supabase
    .from("tenants")
    .select("id")
    .eq("tenant_type", "group")
    .order("id")
    .limit(1)
    .maybeSingle();
  const groupId = (groupTenant as { id?: string } | null)?.id;
  if (groupId) return { ok: true, tenantId: groupId };

  // (3) 最終 fallback: auth_user_admin_tenants() rpc の先頭
  const { data: admin, error: rpcErr } = await supabase.rpc("auth_user_admin_tenants");
  if (rpcErr) {
    return { ok: false, error: "tenant 解決 RPC エラー: " + rpcErr.message };
  }
  type TenantRow = { auth_user_admin_tenants?: string } | string;
  const rows = (admin ?? []) as TenantRow[];
  const fallback = rows
    .map((r) => (typeof r === "string" ? r : r.auth_user_admin_tenants ?? ""))
    .filter(Boolean)[0];
  if (fallback) return { ok: true, tenantId: fallback };

  return {
    ok: false,
    error:
      "あなたは admin 権限を持つ tenant がありません。所長 / 法人管理者 / グループ管理者のどれかに割当てが必要です。",
  };
}
