import { NextResponse } from "next/server";
import { loadStaffToken } from "@/lib/staff-token";
import { createAdminClient } from "@/lib/supabase/admin";

// GET /api/staff-availability/[token]/schedule?date=YYYY-MM-DD
//   token 配下スタッフの 1 日分の訪問予定（cancelled 除外）を返す。
//   利用者名は clients との join で取得（service_role なので必ず tenant_id でも絞る）。

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  const ctx = await loadStaffToken(token);
  if (!ctx) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  if (!date || !DATE_RE.test(date)) {
    return NextResponse.json({ error: "date_required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("kaigo_visit_schedule")
    .select("id, user_id, visit_date, start_time, end_time, service_type, status, notes, clients!inner(name, tenant_id)")
    .eq("staff_id", ctx.staff_id)
    .eq("tenant_id", ctx.tenant_id)
    .eq("clients.tenant_id", ctx.tenant_id)
    .eq("visit_date", date)
    .neq("status", "cancelled")
    .order("start_time");

  if (error) {
    return NextResponse.json({ error: "fetch_failed", detail: error.message }, { status: 500 });
  }

  type Row = {
    id: string;
    user_id: string;
    visit_date: string;
    start_time: string;
    end_time: string;
    service_type: string;
    status: string;
    notes: string | null;
    clients: { name: string } | { name: string }[] | null;
  };
  const schedules = ((data ?? []) as Row[]).map((r) => {
    const c = Array.isArray(r.clients) ? r.clients[0] : r.clients;
    return {
      id: r.id,
      user_id: r.user_id,
      visit_date: r.visit_date,
      start_time: r.start_time,
      end_time: r.end_time,
      service_type: r.service_type,
      status: r.status,
      notes: r.notes,
      user_name: c?.name ?? "不明",
    };
  });

  return NextResponse.json({ schedules });
}
