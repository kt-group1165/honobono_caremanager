"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function createRecipientCert(input: {
  client_id: string;
  recipient_number?: string;
  municipality_code?: string;
  disability_category?: string;
  disability_class?: number;
  benefit_start_date?: string;
  benefit_end_date?: string;
  self_payment_limit?: number;
  self_payment_percent?: number;
  seiho_flag?: boolean;
  soudan_office_name?: string;
  soudan_manager_name?: string;
  notes?: string;
  tenant_id: string;
}): Promise<void> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("shogai_recipient_certs")
    .insert({
      client_id: input.client_id,
      recipient_number: input.recipient_number ?? null,
      municipality_code: input.municipality_code ?? null,
      disability_category: input.disability_category ?? null,
      disability_class: input.disability_class ?? null,
      benefit_start_date: input.benefit_start_date ?? null,
      benefit_end_date: input.benefit_end_date ?? null,
      self_payment_limit: input.self_payment_limit ?? 0,
      self_payment_percent: input.self_payment_percent ?? 10.0,
      seiho_flag: input.seiho_flag ?? false,
      soudan_office_name: input.soudan_office_name ?? null,
      soudan_manager_name: input.soudan_manager_name ?? null,
      notes: input.notes ?? null,
      tenant_id: input.tenant_id,
    })
    .select("id")
    .single();
  if (error) throw new Error(`INSERT 失敗: ${error.message}`);
  revalidatePath("/shogai/recipients");
  redirect(`/shogai/recipients/${data.id}`);
}

export async function updateRecipientCert(
  id: string,
  input: {
    recipient_number?: string | null;
    municipality_code?: string | null;
    disability_category?: string | null;
    disability_class?: number | null;
    benefit_start_date?: string | null;
    benefit_end_date?: string | null;
    self_payment_limit?: number;
    self_payment_percent?: number;
    seiho_flag?: boolean;
    soudan_office_name?: string | null;
    soudan_manager_name?: string | null;
    notes?: string | null;
  },
): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("shogai_recipient_certs")
    .update(input)
    .eq("id", id);
  if (error) throw new Error(`UPDATE 失敗: ${error.message}`);
  revalidatePath("/shogai/recipients");
  revalidatePath(`/shogai/recipients/${id}`);
}

export async function upsertAllocation(input: {
  cert_id: string;
  service_type: string;
  monthly_units: number;
  monthly_minutes?: number | null;
  notes?: string | null;
  id?: string;
}): Promise<void> {
  const supabase = await createClient();
  if (input.id) {
    const { error } = await supabase
      .from("shogai_benefit_allocations")
      .update({
        service_type: input.service_type,
        monthly_units: input.monthly_units,
        monthly_minutes: input.monthly_minutes ?? null,
        notes: input.notes ?? null,
      })
      .eq("id", input.id);
    if (error) throw new Error(`UPDATE 失敗: ${error.message}`);
  } else {
    const { error } = await supabase.from("shogai_benefit_allocations").insert({
      cert_id: input.cert_id,
      service_type: input.service_type,
      monthly_units: input.monthly_units,
      monthly_minutes: input.monthly_minutes ?? null,
      notes: input.notes ?? null,
    });
    if (error) throw new Error(`INSERT 失敗: ${error.message}`);
  }
  revalidatePath(`/shogai/recipients/${input.cert_id}`);
}

export async function deleteAllocation(
  allocationId: string,
  certId: string,
): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("shogai_benefit_allocations")
    .delete()
    .eq("id", allocationId);
  if (error) throw new Error(`DELETE 失敗: ${error.message}`);
  revalidatePath(`/shogai/recipients/${certId}`);
}
