import { NextResponse } from "next/server";
import { loadStaffToken } from "@/lib/staff-token";
import { createAdminClient } from "@/lib/supabase/admin";

// /api/staff-availability/[token]/base
//   GET : token 配下スタッフの週間ベース勤務可能スロット一覧
//   PUT : ボディ { slots:[{day_of_week,start_time,end_time}] } で全置換
//
// token から導出した staff_id / tenant_id にスコープして DB 操作。
// クライアントから渡る staff_id は無視する（スコープ漏洩防止）。

type BaseSlotInput = {
  day_of_week: number;
  start_time: string;
  end_time: string;
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function isValidSlot(s: unknown): s is BaseSlotInput {
  if (!s || typeof s !== "object") return false;
  const r = s as Record<string, unknown>;
  return (
    typeof r.day_of_week === "number" &&
    Number.isInteger(r.day_of_week) &&
    r.day_of_week >= 0 &&
    r.day_of_week <= 6 &&
    typeof r.start_time === "string" &&
    TIME_RE.test(r.start_time) &&
    typeof r.end_time === "string" &&
    TIME_RE.test(r.end_time)
  );
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  const ctx = await loadStaffToken(token);
  if (!ctx) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("kaigo_staff_availability_base")
    .select("id, day_of_week, start_time, end_time")
    .eq("staff_id", ctx.staff_id)
    .eq("tenant_id", ctx.tenant_id)
    .order("day_of_week")
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

  const slots = (body as { slots?: unknown })?.slots;
  if (!Array.isArray(slots)) {
    return NextResponse.json({ error: "slots_required" }, { status: 400 });
  }
  if (!slots.every(isValidSlot)) {
    return NextResponse.json({ error: "slot_invalid" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { error: delErr } = await admin
    .from("kaigo_staff_availability_base")
    .delete()
    .eq("staff_id", ctx.staff_id)
    .eq("tenant_id", ctx.tenant_id);
  if (delErr) {
    return NextResponse.json({ error: "delete_failed", detail: delErr.message }, { status: 500 });
  }

  if (slots.length > 0) {
    const rows = slots.map((s) => ({
      staff_id: ctx.staff_id,
      tenant_id: ctx.tenant_id,
      day_of_week: s.day_of_week,
      start_time: s.start_time,
      end_time: s.end_time,
    }));
    const { error: insErr } = await admin
      .from("kaigo_staff_availability_base")
      .insert(rows);
    if (insErr) {
      return NextResponse.json({ error: "insert_failed", detail: insErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, count: slots.length });
}
