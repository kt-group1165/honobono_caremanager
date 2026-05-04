import { createAdminClient } from "@/lib/supabase/admin";

// /emergency/[token] 経路の token 検証共通ロジック。
//
// token は INSERT 時に gen_random_uuid() / random base64 等で生成される
// unguessable な値。これ自体が認証要素として機能する（≥ 16 文字を要求）。
//
// 戻り値の tenant_id を使って、後続クエリを必ずその tenant にスコープする
// こと（service_role は RLS をバイパスするため、明示 .eq("tenant_id", ...)
// で絞らないと別 tenant が漏れる）。

export type EmergencyTokenContext = {
  id: string;
  tenant_id: string;
  name: string;
};

export async function loadEmergencyToken(
  token: string
): Promise<EmergencyTokenContext | null> {
  if (!token || token.length < 8) return null;

  const admin = createAdminClient();
  const { data } = await admin
    .from("kaigo_emergency_tokens")
    .select("id, tenant_id, name")
    .eq("token", token)
    .maybeSingle();

  const row = data as EmergencyTokenContext | null;
  return row ?? null;
}
