import { NextResponse } from "next/server";
import { loadSupportToken } from "@/lib/support-token";

// GET /api/support/[token]
// token の妥当性を検証し、表示用 metadata を返す。
export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  const ctx = await loadSupportToken(token);
  if (!ctx) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ id: ctx.id, name: ctx.name });
}
