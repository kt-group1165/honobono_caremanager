import { NextResponse } from "next/server";
import { loadSupportToken } from "@/lib/support-token";
import { createAdminClient } from "@/lib/supabase/admin";

// DELETE /api/support/[token]/records/[id]
// 誤入力取り消し用。token の tenant_id にスコープして削除。
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ token: string; id: string }> }
) {
  const { token, id } = await context.params;
  const ctx = await loadSupportToken(token);
  if (!ctx) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!id || id.length === 0) {
    return NextResponse.json({ error: "id_required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("kaigo_support_records")
    .delete()
    .eq("id", id)
    .eq("tenant_id", ctx.tenant_id)
    .select("id");

  if (error) {
    return NextResponse.json({ error: "delete_failed", detail: error.message }, { status: 500 });
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
