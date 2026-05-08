import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  generateInitialPassword,
  generateToken,
  hashPassword,
} from "@/lib/invitations";
import {
  dedupLoginId,
  extractLoginIdHint,
  isValidLoginId,
} from "@/lib/login_id";
import { createClient as createAdminClient } from "@supabase/supabase-js";

// POST /api/staff/invite (kaigo-app)
//
// office_admin / company_admin / group_admin が新しいスタッフを招待する。
// 入力:   { display_name, office_id, role, member_id?, login_id? }
// 出力:   { token, invite_url, initial_password, expires_at }
//
// invite_url は calendar-app の /invite/<token> に向ける (kaigo-app には招待
// 受領 UI が無いため)。NEXT_PUBLIC_CALENDAR_APP_URL があればそれを base に、
// 無ければ request の origin を fallback とする。
//
// 権限検証:
//   - 呼出ユーザが auth セッション持ち
//   - 指定 office_id が auth_admin_office_ids() に含まれる（= 招待者がその
//     office に対する管理権限を持っている）
//
// 注: staff_invitations への INSERT は authenticated 経路（cookies の anon
//     client）で行うので、staff_invitations_admin_manage policy が改めて
//     `office_id IN visible AND created_by = auth.uid()` を enforce する。
//     ここがサーバ事前チェックの defense in depth。

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { display_name, office_id, role, member_id, login_id } = (body ?? {}) as {
    display_name?: unknown;
    office_id?: unknown;
    role?: unknown;
    member_id?: unknown;
    login_id?: unknown;
  };

  if (typeof display_name !== "string" || display_name.trim().length === 0 || display_name.length > 64) {
    return NextResponse.json({ error: "display_name_invalid" }, { status: 400 });
  }
  if (typeof office_id !== "string" || office_id.length === 0) {
    return NextResponse.json({ error: "office_id_invalid" }, { status: 400 });
  }
  if (role !== "office_admin" && role !== "member") {
    return NextResponse.json({ error: "role_invalid" }, { status: 400 });
  }
  if (member_id !== undefined && member_id !== null && typeof member_id !== "string") {
    return NextResponse.json({ error: "member_id_invalid" }, { status: 400 });
  }
  // login_id は optional。指定があれば format チェック、無ければ display_name から自動派生。
  if (login_id !== undefined && login_id !== null && typeof login_id !== "string") {
    return NextResponse.json({ error: "login_id_invalid" }, { status: 400 });
  }
  const requestedLoginId = typeof login_id === "string" && login_id.trim().length > 0
    ? login_id.trim().toLowerCase()
    : null;
  // 指定があった場合は format 検証
  if (requestedLoginId !== null && !isValidLoginId(requestedLoginId)) {
    return NextResponse.json({ error: "login_id_invalid" }, { status: 400 });
  }

  const supabase = await createClient();

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const callerId = userData.user.id;

  // 事前チェック: 呼出ユーザが指定 office に対して admin 権限を持つか。
  //   auth_admin_office_ids() = group_admin / company_admin / office_admin
  //   が招待発行可能な office 集合（member は含まない）。
  //   defense in depth: RLS policy も同関数で enforce している。
  const { data: adminRows, error: adminError } = await supabase.rpc(
    "auth_admin_office_ids"
  );
  if (adminError) {
    return NextResponse.json({ error: "permission_check_failed" }, { status: 500 });
  }
  type AdminRow = { auth_admin_office_ids?: string } | string;
  const adminOfficeIds = ((adminRows ?? []) as AdminRow[]).map((r) =>
    typeof r === "string" ? r : r.auth_admin_office_ids ?? ""
  );
  if (!adminOfficeIds.includes(office_id)) {
    return NextResponse.json({ error: "office_not_allowed" }, { status: 403 });
  }

  // login_id 確定: requested → 派生 → dedup
  // 1) base 候補を決める
  const baseLoginId = requestedLoginId ?? extractLoginIdHint(display_name.trim());
  if (!baseLoginId) {
    // display_name に英字が無く login_id も指定されなかったケース
    return NextResponse.json(
      {
        error: "login_id_required",
        message: "表示名から login_id を自動派生できませんでした。login_id を明示的に指定してください。",
      },
      { status: 400 }
    );
  }

  // 2) 既に使われている login_id を集める (auth.users + 未 consume 招待)
  //    auth.admin.listUsers は anon clients から見えないので service_role で別途。
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SERVICE_KEY) {
    return NextResponse.json({ error: "service_key_missing" }, { status: 500 });
  }
  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    SERVICE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const taken = new Set<string>();
  // 2a) 既存 auth.users の synthetic email から逆引き
  const { data: usersList, error: listError } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listError) {
    return NextResponse.json({ error: "list_users_failed" }, { status: 500 });
  }
  for (const u of usersList?.users ?? []) {
    const email = u.email ?? "";
    const lid = email.endsWith("@kt-staff.invalid") ? email.split("@")[0] : null;
    if (lid) taken.add(lid);
  }
  // 2b) 未 consume の招待からも収集 (発行済みだが未使用のものとも衝突を避ける)
  const { data: pendingInvites } = await admin
    .from("staff_invitations")
    .select("login_id")
    .is("consumed_at", null)
    .not("login_id", "is", null);
  for (const r of (pendingInvites ?? []) as { login_id: string | null }[]) {
    if (r.login_id) taken.add(r.login_id);
  }

  // 3) base 自体が空いてれば base、衝突したら base2, base3, …
  const finalLoginId = dedupLoginId(baseLoginId, taken);
  if (!finalLoginId) {
    return NextResponse.json(
      { error: "login_id_dedup_exhausted", message: "login_id の連番候補を使い切りました (base + 1〜999)。別の base を指定してください。" },
      { status: 409 }
    );
  }

  // 招待発行
  const token = generateToken();
  const initialPassword = generateInitialPassword();
  const initialPasswordHash = await hashPassword(initialPassword);

  const { error: insertError } = await supabase.from("staff_invitations").insert({
    token,
    display_name: display_name.trim(),
    office_id,
    role,
    member_id: member_id ?? null,
    login_id: finalLoginId,
    initial_password_hash: initialPasswordHash,
    created_by: callerId,
    // expires_at は DB default (NOW() + 7d) に任せる
  });
  if (insertError) {
    // policy 違反 / FK 違反など。原因を詳細には返さない。
    return NextResponse.json(
      { error: "insert_failed", detail: insertError.message },
      { status: 400 }
    );
  }

  // 戻り値の expires_at を取得（クライアントに表示するため）
  const { data: row } = await supabase
    .from("staff_invitations")
    .select("expires_at")
    .eq("token", token)
    .maybeSingle();

  // invite_url base: NEXT_PUBLIC_CALENDAR_APP_URL があれば使う (kaigo-app には
  // /invite UI が無いため calendar-app に向ける)、無ければ request origin を fallback。
  const calendarBase = process.env.NEXT_PUBLIC_CALENDAR_APP_URL?.replace(/\/$/, "");
  const fallbackOrigin = request.headers.get("origin") ?? new URL(request.url).origin;
  const inviteUrl = `${calendarBase ?? fallbackOrigin}/invite/${token}`;

  return NextResponse.json({
    token,
    invite_url: inviteUrl,
    initial_password: initialPassword,
    login_id: finalLoginId,
    login_id_was_renamed: requestedLoginId !== null && requestedLoginId !== finalLoginId,
    expires_at: row?.expires_at ?? null,
  });
}
