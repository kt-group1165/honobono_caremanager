import { NextResponse } from "next/server";
import { loadSupportToken } from "@/lib/support-token";
import { createAdminClient } from "@/lib/supabase/admin";

// GET /api/support/[token]/templates?category=support_record
//
// kaigo_record_templates から該当 category + 'common' のテンプレを返す。
// kaigo_record_templates は authenticated 限定 RLS（Phase 2-5-09）のため、
// anon 経路の TemplatePicker からは service_role API 経由で取得する必要がある。
//
// kaigo_record_templates は tenant_id 列を持たないグローバル master 想定だが、
// 念のため token を認証要素として要求する。
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
  const category = url.searchParams.get("category");
  if (!category) {
    return NextResponse.json({ error: "category_required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("kaigo_record_templates")
    .select("id, category, label, content")
    .in("category", [category, "common"])
    .order("sort_order");

  if (error) {
    return NextResponse.json({ error: "fetch_failed", detail: error.message }, { status: 500 });
  }

  return NextResponse.json({ templates: data ?? [] });
}
