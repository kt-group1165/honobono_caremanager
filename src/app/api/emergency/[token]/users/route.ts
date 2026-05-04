import { NextResponse } from "next/server";
import { loadEmergencyToken } from "@/lib/emergency-token";
import { createAdminClient } from "@/lib/supabase/admin";

// GET /api/emergency/[token]/users?manager=<member_id>
//
// 指定ケアマネが担当している、該当 tenant の active 在宅利用者一覧と、
// この token に対する安否ステータス・サービス調整ステータスを返す。
export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  const ctx = await loadEmergencyToken(token);
  if (!ctx) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const managerId = url.searchParams.get("manager");
  if (!managerId) {
    return NextResponse.json({ error: "manager_required" }, { status: 400 });
  }

  const admin = createAdminClient();

  const [{ data: clientsData, error: clientsErr }, { data: statusData, error: statusErr }] = await Promise.all([
    admin
      .from("clients")
      .select("id, name, name_kana:furigana, care_manager_staff_id")
      .eq("status", "active")
      .eq("is_facility", false)
      .eq("tenant_id", ctx.tenant_id)
      .eq("care_manager_staff_id", managerId)
      .order("furigana"),
    admin
      .from("kaigo_emergency_status")
      .select("user_id, safety_status, service_status")
      .eq("token_id", ctx.id)
      .eq("tenant_id", ctx.tenant_id),
  ]);

  if (clientsErr || statusErr) {
    return NextResponse.json(
      { error: "fetch_failed", detail: clientsErr?.message ?? statusErr?.message },
      { status: 500 }
    );
  }

  type StatusRow = { user_id: string; safety_status: string | null; service_status: string | null };
  const statusMap = new Map<string, { safety: string; service: string }>();
  for (const s of (statusData ?? []) as StatusRow[]) {
    statusMap.set(s.user_id, {
      safety: s.safety_status ?? "",
      service: s.service_status ?? "",
    });
  }

  type ClientRow = { id: string; name: string; name_kana: string | null };
  const users = ((clientsData ?? []) as ClientRow[]).map((u) => ({
    id: u.id,
    name: u.name,
    name_kana: u.name_kana ?? "",
    safety_status: statusMap.get(u.id)?.safety ?? "",
    service_status: statusMap.get(u.id)?.service ?? "",
  }));

  return NextResponse.json({ users });
}
