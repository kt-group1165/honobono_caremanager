import { NextResponse } from "next/server";
import { loadSupportToken } from "@/lib/support-token";
import { createAdminClient } from "@/lib/supabase/admin";

// /api/support/[token]/records
// GET ?user=<client_id>     : 該当利用者の支援経過一覧
// POST { user_id, record_date, record_time?, category, content, staff_name? }
//                            : 新規 INSERT（tenant scope は token から導出）
//
// user_id が token の tenant に属するか必ず検証して別 tenant 漏洩を防ぐ。

const ALLOWED_CATEGORIES = new Set([
  "電話", "訪問", "来所", "メール", "FAX", "カンファレンス",
  "サービス担当者会議", "モニタリング", "その他",
]);

async function ensureUserInTenant(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  tenantId: string
): Promise<boolean> {
  const { data } = await admin
    .from("clients")
    .select("id")
    .eq("id", userId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  return Boolean(data);
}

// ────────────────────────────────────────────────────────────────────
// GET: records list for a user
// ────────────────────────────────────────────────────────────────────
export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  const ctx = await loadSupportToken(token);
  if (!ctx) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const userId = url.searchParams.get("user");
  if (!userId) {
    return NextResponse.json({ error: "user_required" }, { status: 400 });
  }

  const admin = createAdminClient();
  if (!(await ensureUserInTenant(admin, userId, ctx.tenant_id))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const { data, error } = await admin
    .from("kaigo_support_records")
    .select("id, user_id, record_date, record_time, category, content, staff_name, created_at")
    .eq("user_id", userId)
    .eq("tenant_id", ctx.tenant_id)
    .order("record_date", { ascending: false })
    .order("record_time", { ascending: false });

  if (error) {
    return NextResponse.json({ error: "fetch_failed", detail: error.message }, { status: 500 });
  }

  return NextResponse.json({ records: data ?? [] });
}

// ────────────────────────────────────────────────────────────────────
// POST: create a new record
// ────────────────────────────────────────────────────────────────────
export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  const ctx = await loadSupportToken(token);
  if (!ctx) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { user_id, record_date, record_time, category, content, staff_name } = (body ?? {}) as {
    user_id?: unknown;
    record_date?: unknown;
    record_time?: unknown;
    category?: unknown;
    content?: unknown;
    staff_name?: unknown;
  };

  if (typeof user_id !== "string" || user_id.length === 0) {
    return NextResponse.json({ error: "user_id_required" }, { status: 400 });
  }
  if (typeof record_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(record_date)) {
    return NextResponse.json({ error: "record_date_invalid" }, { status: 400 });
  }
  if (record_time !== null && record_time !== undefined && typeof record_time !== "string") {
    return NextResponse.json({ error: "record_time_invalid" }, { status: 400 });
  }
  if (typeof category !== "string" || !ALLOWED_CATEGORIES.has(category)) {
    return NextResponse.json({ error: "category_invalid" }, { status: 400 });
  }
  if (typeof content !== "string" || content.trim().length === 0) {
    return NextResponse.json({ error: "content_required" }, { status: 400 });
  }
  if (staff_name !== null && staff_name !== undefined && typeof staff_name !== "string") {
    return NextResponse.json({ error: "staff_name_invalid" }, { status: 400 });
  }

  const admin = createAdminClient();
  if (!(await ensureUserInTenant(admin, user_id, ctx.tenant_id))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const { data, error } = await admin
    .from("kaigo_support_records")
    .insert({
      user_id,
      tenant_id: ctx.tenant_id,
      record_date,
      record_time: record_time || null,
      category,
      content,
      staff_name: staff_name || null,
    })
    .select("id")
    .single();

  if (error) {
    return NextResponse.json({ error: "insert_failed", detail: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: (data as { id: string }).id });
}
