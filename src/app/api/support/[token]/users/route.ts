import { NextResponse } from "next/server";
import { loadSupportToken } from "@/lib/support-token";
import { createAdminClient } from "@/lib/supabase/admin";

// GET /api/support/[token]/users
// 該当 tenant の active な在宅利用者一覧を返す（manager フィルタ無し、support flow の仕様）。
export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  const ctx = await loadSupportToken(token);
  if (!ctx) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("clients")
    .select("id, name, name_kana:furigana")
    .eq("status", "active")
    .eq("is_facility", false)
    .eq("tenant_id", ctx.tenant_id)
    .order("furigana");

  if (error) {
    return NextResponse.json({ error: "fetch_failed", detail: error.message }, { status: 500 });
  }

  return NextResponse.json({ users: data ?? [] });
}
