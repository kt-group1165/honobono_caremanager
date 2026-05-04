import { createAdminClient } from "@/lib/supabase/admin";

// /staff-availability/[token] 経路の token 検証共通ロジック。
// emergency-token.ts / support-token.ts と同パターンだが、kaigo_staff_tokens は
// 親無し token 表でありながら staff_id（→ members）を必ず持つため、
// staff metadata（name / name_kana）も同じ呼び出しで返す。
//
// 戻り値の tenant_id を使って後続クエリを必ずその tenant にスコープする
// （service_role は RLS バイパスのため明示 .eq("tenant_id", ...) が必須）。

export type StaffTokenContext = {
  id: string;
  tenant_id: string;
  staff_id: string;
  staff_name: string;
  staff_name_kana: string | null;
};

export async function loadStaffToken(
  token: string
): Promise<StaffTokenContext | null> {
  if (!token || token.length < 8) return null;

  const admin = createAdminClient();

  const { data: tokenRow } = await admin
    .from("kaigo_staff_tokens")
    .select("id, tenant_id, staff_id")
    .eq("token", token)
    .maybeSingle();

  if (!tokenRow) return null;
  const t = tokenRow as { id: string; tenant_id: string; staff_id: string };

  const { data: memberRow } = await admin
    .from("members")
    .select("id, name, name_kana:furigana, tenant_id")
    .eq("id", t.staff_id)
    .eq("tenant_id", t.tenant_id)
    .maybeSingle();

  if (!memberRow) return null;
  const m = memberRow as { id: string; name: string; name_kana: string | null };

  return {
    id: t.id,
    tenant_id: t.tenant_id,
    staff_id: t.staff_id,
    staff_name: m.name,
    staff_name_kana: m.name_kana,
  };
}
