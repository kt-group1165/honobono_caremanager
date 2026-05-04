import { createAdminClient } from "@/lib/supabase/admin";

// /support/[token] 経路の token 検証共通ロジック。emergency-token.ts と同パターン。
//
// token は INSERT 時に gen_random_uuid() で生成される unguessable な値。
// 戻り値の tenant_id を使って、後続クエリを必ずその tenant にスコープする。

export type SupportTokenContext = {
  id: string;
  tenant_id: string;
  name: string;
};

export async function loadSupportToken(
  token: string
): Promise<SupportTokenContext | null> {
  if (!token || token.length < 8) return null;

  const admin = createAdminClient();
  const { data } = await admin
    .from("kaigo_support_tokens")
    .select("id, tenant_id, name")
    .eq("token", token)
    .maybeSingle();

  const row = data as SupportTokenContext | null;
  return row ?? null;
}
