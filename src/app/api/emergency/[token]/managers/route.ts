import { NextResponse } from "next/server";
import { loadEmergencyToken } from "@/lib/emergency-token";
import { createAdminClient } from "@/lib/supabase/admin";

// GET /api/emergency/[token]/managers
//
// 該当 tenant の active な members（ケアマネ候補）一覧を返す。
export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  const ctx = await loadEmergencyToken(token);
  if (!ctx) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("members")
    .select("id, name")
    .eq("status", "active")
    .eq("tenant_id", ctx.tenant_id)
    .order("name");

  if (error) {
    return NextResponse.json({ error: "fetch_failed", detail: error.message }, { status: 500 });
  }

  return NextResponse.json({ managers: data ?? [] });
}
