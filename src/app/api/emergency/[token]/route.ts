import { NextResponse } from "next/server";
import { loadEmergencyToken } from "@/lib/emergency-token";

// GET /api/emergency/[token]
//
// token の妥当性を検証し、表示用 metadata を返す。token 自体が unguessable
// な認証要素。失敗時は 404 で曖昧に返す（token 存在をオラクルしない）。
export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  const ctx = await loadEmergencyToken(token);
  if (!ctx) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ id: ctx.id, name: ctx.name });
}
