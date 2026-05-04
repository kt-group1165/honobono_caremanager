import { NextResponse } from "next/server";
import { loadStaffToken } from "@/lib/staff-token";
import { createAdminClient } from "@/lib/supabase/admin";

// GET /api/staff-availability/[token]/schedule/dates?from=YYYY-MM-DD&to=YYYY-MM-DD
//   カレンダーの「シフトある日にドット」表示用に、範囲内で訪問予定が
//   1 件以上ある日付の集合を返す（cancelled 除外）。

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
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to)) {
    return NextResponse.json({ error: "from_to_required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("kaigo_visit_schedule")
    .select("visit_date")
    .eq("staff_id", ctx.staff_id)
    .eq("tenant_id", ctx.tenant_id)
    .gte("visit_date", from)
    .lte("visit_date", to)
    .neq("status", "cancelled");

  if (error) {
    return NextResponse.json({ error: "fetch_failed", detail: error.message }, { status: 500 });
  }

  const set = new Set<string>();
  for (const r of (data ?? []) as { visit_date: string }[]) set.add(r.visit_date);

  return NextResponse.json({ dates: Array.from(set) });
}
