import { NextResponse } from "next/server";
import { loadStaffToken } from "@/lib/staff-token";
import { createAdminClient } from "@/lib/supabase/admin";

// POST /api/staff-availability/[token]/monthly/import-base
//   ボディ { from: "YYYY-MM-DD", to: "YYYY-MM-DD" }
//
// [from, to] 範囲の各日について kaigo_staff_availability_base を引いて
// kaigo_staff_availability_monthly に投入する。同範囲の既存行は事前に DELETE。
//
// 該当 day_of_week のベースが無い日は、is_available=false の placeholder を 1 行入れる
// （元コードの挙動を踏襲、画面上「対応不可」としてグレー表示するため）。

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function eachDayInclusive(from: string, to: string): string[] {
  const start = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  if (start.getTime() > end.getTime()) return [];
  const out: string[] = [];
  for (let d = new Date(start); d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function dayOfWeekUTC(dateStr: string): number {
  return new Date(dateStr + "T00:00:00Z").getUTCDay();
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  const ctx = await loadStaffToken(token);
  if (!ctx) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { from, to } = (body ?? {}) as { from?: unknown; to?: unknown };
  if (typeof from !== "string" || !DATE_RE.test(from) ||
      typeof to !== "string" || !DATE_RE.test(to)) {
    return NextResponse.json({ error: "from_to_required" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: baseData, error: baseErr } = await admin
    .from("kaigo_staff_availability_base")
    .select("day_of_week, start_time, end_time")
    .eq("staff_id", ctx.staff_id)
    .eq("tenant_id", ctx.tenant_id);
  if (baseErr) {
    return NextResponse.json({ error: "base_fetch_failed", detail: baseErr.message }, { status: 500 });
  }
  const base = (baseData ?? []) as { day_of_week: number; start_time: string; end_time: string }[];
  if (base.length === 0) {
    return NextResponse.json({ error: "base_empty" }, { status: 409 });
  }

  const { error: delErr } = await admin
    .from("kaigo_staff_availability_monthly")
    .delete()
    .eq("staff_id", ctx.staff_id)
    .eq("tenant_id", ctx.tenant_id)
    .gte("available_date", from)
    .lte("available_date", to);
  if (delErr) {
    return NextResponse.json({ error: "delete_failed", detail: delErr.message }, { status: 500 });
  }

  const rows: Record<string, unknown>[] = [];
  for (const dateStr of eachDayInclusive(from, to)) {
    const dow = dayOfWeekUTC(dateStr);
    const matching = base.filter((b) => b.day_of_week === dow);
    if (matching.length === 0) {
      rows.push({
        staff_id: ctx.staff_id,
        tenant_id: ctx.tenant_id,
        available_date: dateStr,
        start_time: "00:00",
        end_time: "23:59",
        is_available: false,
        source: "base",
      });
    } else {
      for (const b of matching) {
        rows.push({
          staff_id: ctx.staff_id,
          tenant_id: ctx.tenant_id,
          available_date: dateStr,
          start_time: b.start_time,
          end_time: b.end_time,
          is_available: true,
          source: "base",
        });
      }
    }
  }

  const { error: insErr } = await admin
    .from("kaigo_staff_availability_monthly")
    .insert(rows);
  if (insErr) {
    return NextResponse.json({ error: "insert_failed", detail: insErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, count: rows.length });
}
