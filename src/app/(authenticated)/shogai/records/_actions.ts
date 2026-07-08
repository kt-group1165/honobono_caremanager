"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function createServiceRecord(input: {
  tenant_id: string;
  office_id?: string | null;
  client_id: string;
  cert_id?: string | null;
  service_date: string;
  start_time?: string | null;
  end_time?: string | null;
  duration_minutes?: number | null;
  service_type: string;
  service_category?: string | null;
  service_code?: string | null;
  unit_count?: number | null;
  staff_id?: string | null;
  staff_name_cached?: string | null;
  activities?: string | null;
  client_condition?: string | null;
  handover_notes?: string | null;
  notes?: string | null;
}): Promise<string> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("shogai_service_records")
    .insert({
      ...input,
      addons: [],
      status: "draft",
    })
    .select("id")
    .single();
  if (error) throw new Error(`INSERT 失敗: ${error.message}`);
  revalidatePath("/shogai/records");
  return data.id;
}

export async function updateServiceRecord(
  id: string,
  input: Record<string, unknown>,
): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("shogai_service_records")
    .update(input)
    .eq("id", id);
  if (error) throw new Error(`UPDATE 失敗: ${error.message}`);
  revalidatePath("/shogai/records");
  revalidatePath(`/shogai/records/${id}`);
}

export async function confirmServiceRecord(id: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("shogai_service_records")
    .update({ status: "confirmed" })
    .eq("id", id);
  if (error) throw new Error(`確定失敗: ${error.message}`);
  revalidatePath("/shogai/records");
}

export async function cancelServiceRecord(
  id: string,
  reason: string,
): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("shogai_service_records")
    .update({ status: "cancelled", cancel_reason: reason })
    .eq("id", id);
  if (error) throw new Error(`キャンセル失敗: ${error.message}`);
  revalidatePath("/shogai/records");
}

export async function submitCreateRecord(formData: FormData): Promise<void> {
  const raw = Object.fromEntries(formData.entries()) as Record<string, string>;
  const start = raw.start_time || null;
  const end = raw.end_time || null;
  let duration: number | null = null;
  if (start && end) {
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    duration = eh * 60 + em - (sh * 60 + sm);
    if (duration < 0) duration += 24 * 60;
  }
  const id = await createServiceRecord({
    tenant_id: raw.tenant_id,
    office_id: raw.office_id || null,
    client_id: raw.client_id,
    service_date: raw.service_date,
    start_time: start,
    end_time: end,
    duration_minutes: duration,
    service_type: raw.service_type,
    service_category: raw.service_category || null,
    service_code: raw.service_code || null,
    unit_count: raw.unit_count ? Number(raw.unit_count) : null,
    activities: raw.activities || null,
    client_condition: raw.client_condition || null,
    handover_notes: raw.handover_notes || null,
    notes: raw.notes || null,
  });
  redirect(`/shogai/records/${id}`);
}
