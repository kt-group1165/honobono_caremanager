import { NextResponse } from "next/server";
import { loadStaffToken } from "@/lib/staff-token";
import { createAdminClient } from "@/lib/supabase/admin";

// /api/staff-availability/[token]/monthly
//   GET ?from=YYYY-MM-DD&to=YYYY-MM-DD : 月別スロット一覧
//   PUT ボディ { from, to, slots:[{available_date,start_time,end_time,is_available}] }
//                                       : [from, to] 範囲を全置換
//
// page.tsx は「ベース取り込み / 手動編集」の両方とも同一月の delete + insert
// をやっており、同パターンを範囲指定で API 化。

type MonthlySlotInput = {
  available_date: string;
  start_time: string;
  end_time: string;
  is_available: boolean;
  source?: "base" | "manual";
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function isValidSlot(s: unknown): s is MonthlySlotInput {
  if (!s || typeof s !== "object") return false;
  const r = s as Record<string, unknown>;
  return (
    typeof r.available_date === "string" &&
    DATE_RE.test(r.available_date) &&
    typeof r.start_time === "string" &&
    TIME_RE.test(r.start_time) &&
    typeof r.end_time === "string" &&
    TIME_RE.test(r.end_time) &&
    typeof r.is_available === "boolean" &&
    (r.source === undefined || r.source === "base" || r.source === "manual")
  );
}

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
    .from("kaigo_staff_availability_monthly")
    .select("id, available_date, start_time, end_time, is_available")
    .eq("staff_id", ctx.staff_id)
    .eq("tenant_id", ctx.tenant_id)
    .gte("available_date", from)
    .lte("available_date", to)
    .order("available_date")
    .order("start_time");

  if (error) {
    return NextResponse.json({ error: "fetch_failed", detail: error.message }, { status: 500 });
  }
  return NextResponse.json({ slots: data ?? [] });
}

export async function PUT(
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

  const { from, to, slots } = (body ?? {}) as {
    from?: unknown;
    to?: unknown;
    slots?: unknown;
  };
  if (typeof from !== "string" || !DATE_RE.test(from) ||
      typeof to !== "string" || !DATE_RE.test(to)) {
    return NextResponse.json({ error: "from_to_required" }, { status: 400 });
  }
  if (!Array.isArray(slots)) {
    return NextResponse.json({ error: "slots_required" }, { status: 400 });
  }
  if (!slots.every(isValidSlot)) {
    return NextResponse.json({ error: "slot_invalid" }, { status: 400 });
  }
  for (const s of slots) {
    if (s.available_date < from || s.available_date > to) {
      return NextResponse.json({ error: "slot_out_of_range" }, { status: 400 });
    }
  }

  const admin = createAdminClient();

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

  if (slots.length > 0) {
    const rows = slots.map((s) => ({
      staff_id: ctx.staff_id,
      tenant_id: ctx.tenant_id,
      available_date: s.available_date,
      start_time: s.start_time,
      end_time: s.end_time,
      is_available: s.is_available,
      source: s.source ?? "manual",
    }));
    const { error: insErr } = await admin
      .from("kaigo_staff_availability_monthly")
      .insert(rows);
    if (insErr) {
      return NextResponse.json({ error: "insert_failed", detail: insErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, count: slots.length });
}
