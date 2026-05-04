import { NextResponse } from "next/server";
import { loadEmergencyToken } from "@/lib/emergency-token";
import { createAdminClient } from "@/lib/supabase/admin";

// PATCH /api/emergency/[token]/status
//
// body: { user_id: string, field: 'safety_status' | 'service_status', value: string }
//
// 該当 tenant の利用者に対する emergency status を upsert する。
// user_id が token の tenant に属さない場合は 404（漏洩防止のため曖昧に）。

const ALLOWED_FIELDS = new Set(["safety_status", "service_status"]);
const ALLOWED_VALUES = new Set(["", "◯", "△", "×"]);

export async function PATCH(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  const ctx = await loadEmergencyToken(token);
  if (!ctx) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { user_id, field, value } = (body ?? {}) as {
    user_id?: unknown;
    field?: unknown;
    value?: unknown;
  };

  if (typeof user_id !== "string" || user_id.length === 0) {
    return NextResponse.json({ error: "user_id_required" }, { status: 400 });
  }
  if (typeof field !== "string" || !ALLOWED_FIELDS.has(field)) {
    return NextResponse.json({ error: "field_invalid" }, { status: 400 });
  }
  if (typeof value !== "string" || !ALLOWED_VALUES.has(value)) {
    return NextResponse.json({ error: "value_invalid" }, { status: 400 });
  }

  const admin = createAdminClient();

  // user_id が token の tenant に属するか検証（別 tenant 漏洩防止）
  const { data: clientRow } = await admin
    .from("clients")
    .select("id")
    .eq("id", user_id)
    .eq("tenant_id", ctx.tenant_id)
    .maybeSingle();
  if (!clientRow) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const { data: existing } = await admin
    .from("kaigo_emergency_status")
    .select("id")
    .eq("user_id", user_id)
    .eq("token_id", ctx.id)
    .eq("tenant_id", ctx.tenant_id)
    .maybeSingle();

  if (existing) {
    const { error } = await admin
      .from("kaigo_emergency_status")
      .update({ [field]: value, updated_at: new Date().toISOString() })
      .eq("id", (existing as { id: string }).id);
    if (error) {
      return NextResponse.json({ error: "update_failed", detail: error.message }, { status: 500 });
    }
  } else {
    const { error } = await admin
      .from("kaigo_emergency_status")
      .insert({
        user_id,
        token_id: ctx.id,
        tenant_id: ctx.tenant_id,
        [field]: value,
      });
    if (error) {
      return NextResponse.json({ error: "insert_failed", detail: error.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}
