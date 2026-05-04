import { NextResponse } from "next/server";
import { loadStaffToken } from "@/lib/staff-token";
import { createAdminClient } from "@/lib/supabase/admin";

// /api/staff-availability/[token]/records
//   GET ?date=YYYY-MM-DD : token 配下スタッフの該当日の visit_records 一覧
//   POST ボディ:
//     {
//       id?: string,                  // 指定あり → UPDATE、無し → INSERT
//       user_id: string,              // 必須（tenant 検証）
//       visit_date: string,           // 必須
//       service_type?: string,
//       schedule_id?: string | null,
//       start_time?: string,
//       end_time?: string,
//       care_record_data?: object,    // JSONB 全データ
//       // 旧カラムは互換のため受け付ける（CareRecordModal 経由）
//       vital_temperature?: number | null, ...,
//       user_condition?: string | null,
//       handover_notes?: string | null,
//       notes?: string | null,
//       progress_notes?: string | null,
//       status?: string,
//     }
//
// staff_id は token から導出（クライアントから受け取らない）。
// user_id は同 tenant の clients に存在することを必ず検証。
// 既存 id 指定時は staff_id + tenant_id 一致を WHERE で強制し、別 staff の
// レコードを書き換えられないようにする。

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function asNullableNumber(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asNullableString(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return String(v);
}

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
// GET: records for a date
// ────────────────────────────────────────────────────────────────────
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
  const date = url.searchParams.get("date");
  if (!date || !DATE_RE.test(date)) {
    return NextResponse.json({ error: "date_required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("kaigo_visit_records")
    .select(
      "id, schedule_id, user_id, visit_date, start_time, end_time, body_care, living_support, vital_temperature, vital_bp_sys, vital_bp_dia, vital_pulse, vital_spo2, vital_respiration, vital_blood_sugar, user_condition, handover_notes, notes, progress_notes, care_record_data"
    )
    .eq("staff_id", ctx.staff_id)
    .eq("tenant_id", ctx.tenant_id)
    .eq("visit_date", date);

  if (error) {
    return NextResponse.json({ error: "fetch_failed", detail: error.message }, { status: 500 });
  }
  return NextResponse.json({ records: data ?? [] });
}

// ────────────────────────────────────────────────────────────────────
// POST: upsert (id 指定で UPDATE、無しで INSERT)
// ────────────────────────────────────────────────────────────────────
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
  const b = (body ?? {}) as Record<string, unknown>;

  const id = typeof b.id === "string" ? b.id : null;
  const user_id = b.user_id;
  const visit_date = b.visit_date;

  if (typeof user_id !== "string" || user_id.length === 0) {
    return NextResponse.json({ error: "user_id_required" }, { status: 400 });
  }
  if (typeof visit_date !== "string" || !DATE_RE.test(visit_date)) {
    return NextResponse.json({ error: "visit_date_invalid" }, { status: 400 });
  }
  if (b.start_time !== undefined && (typeof b.start_time !== "string" || !TIME_RE.test(b.start_time))) {
    return NextResponse.json({ error: "start_time_invalid" }, { status: 400 });
  }
  if (b.end_time !== undefined && (typeof b.end_time !== "string" || !TIME_RE.test(b.end_time))) {
    return NextResponse.json({ error: "end_time_invalid" }, { status: 400 });
  }
  if (b.schedule_id !== undefined && b.schedule_id !== null && typeof b.schedule_id !== "string") {
    return NextResponse.json({ error: "schedule_id_invalid" }, { status: 400 });
  }
  if (b.service_type !== undefined && typeof b.service_type !== "string") {
    return NextResponse.json({ error: "service_type_invalid" }, { status: 400 });
  }
  if (b.care_record_data !== undefined && (typeof b.care_record_data !== "object" || b.care_record_data === null)) {
    return NextResponse.json({ error: "care_record_data_invalid" }, { status: 400 });
  }

  const admin = createAdminClient();
  if (!(await ensureUserInTenant(admin, user_id, ctx.tenant_id))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const payload: Record<string, unknown> = {
    user_id,
    visit_date,
    staff_id: ctx.staff_id,
    tenant_id: ctx.tenant_id,
    status: typeof b.status === "string" ? b.status : "draft",
  };
  if (b.service_type !== undefined) payload.service_type = b.service_type;
  if (b.schedule_id !== undefined) payload.schedule_id = b.schedule_id;
  if (b.start_time !== undefined) payload.start_time = b.start_time;
  if (b.end_time !== undefined) payload.end_time = b.end_time;
  if (b.care_record_data !== undefined) payload.care_record_data = b.care_record_data;

  const numericKeys = [
    "vital_temperature", "vital_bp_sys", "vital_bp_dia", "vital_pulse",
    "vital_spo2", "vital_respiration", "vital_blood_sugar",
  ] as const;
  for (const k of numericKeys) {
    const v = asNullableNumber(b[k]);
    if (v !== undefined) payload[k] = v;
  }
  const stringKeys = ["user_condition", "handover_notes", "notes", "progress_notes"] as const;
  for (const k of stringKeys) {
    const v = asNullableString(b[k]);
    if (v !== undefined) payload[k] = v;
  }

  if (id) {
    const { data, error } = await admin
      .from("kaigo_visit_records")
      .update(payload)
      .eq("id", id)
      .eq("staff_id", ctx.staff_id)
      .eq("tenant_id", ctx.tenant_id)
      .select("id");
    if (error) {
      return NextResponse.json({ error: "update_failed", detail: error.message }, { status: 500 });
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, id: (data[0] as { id: string }).id });
  } else {
    const { data, error } = await admin
      .from("kaigo_visit_records")
      .insert(payload)
      .select("id")
      .single();
    if (error) {
      return NextResponse.json({ error: "insert_failed", detail: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, id: (data as { id: string }).id });
  }
}
