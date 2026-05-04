import { NextResponse } from "next/server";
import { loadStaffToken } from "@/lib/staff-token";

// GET /api/staff-availability/[token]
// token の妥当性を検証し、表示用 staff metadata を返す。
// token 自体が unguessable な認証要素。失敗時は 404（token 存在をオラクルしない）。
export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  const ctx = await loadStaffToken(token);
  if (!ctx) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({
    staff_id: ctx.staff_id,
    name: ctx.staff_name,
    name_kana: ctx.staff_name_kana,
  });
}
