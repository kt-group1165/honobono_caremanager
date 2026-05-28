/**
 * 訪問介護 手順書 機能の Supabase queries
 *
 * 3 table を協調操作:
 *  - kaigo_visit_procedure_documents
 *  - kaigo_visit_procedure_services
 *  - kaigo_visit_procedure_steps
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  VisitProcedureDocument,
  VisitProcedureDocumentSummary,
  VisitProcedureService,
  VisitProcedureStep,
} from "./types";

// PostgREST 1000 行制限対応 (project_pagination_audit_remaining.md)
const PAGE_LIMIT = 1000;

export async function getDocuments(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<VisitProcedureDocumentSummary[]> {
  const all: VisitProcedureDocumentSummary[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("kaigo_visit_procedure_documents")
      .select("id, client_name, plan_start_date, author_name, creation_reason, created_at, updated_at")
      .eq("tenant_id", tenantId)
      .order("plan_start_date", { ascending: false })
      .order("client_name", { ascending: true })
      .range(from, from + PAGE_LIMIT - 1);
    if (error) throw error;
    const rows = (data ?? []) as VisitProcedureDocumentSummary[];
    all.push(...rows);
    if (rows.length < PAGE_LIMIT) break;
    from += PAGE_LIMIT;
  }
  return all;
}

export async function getDocument(
  supabase: SupabaseClient,
  id: string,
): Promise<VisitProcedureDocument | null> {
  const { data: doc, error: docErr } = await supabase
    .from("kaigo_visit_procedure_documents")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (docErr) throw docErr;
  if (!doc) return null;

  const { data: services, error: svcErr } = await supabase
    .from("kaigo_visit_procedure_services")
    .select("*")
    .eq("document_id", id)
    .order("service_no", { ascending: true });
  if (svcErr) throw svcErr;

  const svcRows = (services ?? []) as Array<Omit<VisitProcedureService, "steps">>;
  const svcIds = svcRows.map((s) => s.id).filter((v): v is string => !!v);

  let steps: VisitProcedureStep[] = [];
  if (svcIds.length > 0) {
    const { data: stepData, error: stepErr } = await supabase
      .from("kaigo_visit_procedure_steps")
      .select("*")
      .in("service_id", svcIds)
      .order("step_no", { ascending: true });
    if (stepErr) throw stepErr;
    steps = (stepData ?? []) as VisitProcedureStep[];
  }

  const stepsBySvc: Record<string, VisitProcedureStep[]> = {};
  for (const st of steps) {
    const key = st.service_id ?? "";
    if (!stepsBySvc[key]) stepsBySvc[key] = [];
    stepsBySvc[key].push(st);
  }

  const fullServices: VisitProcedureService[] = svcRows.map((s) => ({
    ...s,
    steps: s.id ? stepsBySvc[s.id] ?? [] : [],
  }));

  return {
    ...(doc as Omit<VisitProcedureDocument, "services">),
    services: fullServices,
  };
}

/**
 * document 一括 upsert
 *  - documents: id 有なら UPDATE / 無なら INSERT (id 返却)
 *  - services: 既存全 DELETE → 5 サービス INSERT (空でも)
 *  - steps: services と同様に DELETE → INSERT
 */
export async function saveDocument(
  supabase: SupabaseClient,
  doc: VisitProcedureDocument,
): Promise<string> {
  let docId = doc.id ?? null;

  const docPayload = {
    tenant_id: doc.tenant_id,
    office_id: doc.office_id,
    client_name: doc.client_name,
    plan_start_date: doc.plan_start_date,
    author_name: doc.author_name,
    creation_reason: doc.creation_reason,
    special_notes: doc.special_notes,
    weekly_schedule: doc.weekly_schedule,
  };

  if (docId) {
    const { error } = await supabase
      .from("kaigo_visit_procedure_documents")
      .update(docPayload)
      .eq("id", docId);
    if (error) throw error;
  } else {
    const { data, error } = await supabase
      .from("kaigo_visit_procedure_documents")
      .insert(docPayload)
      .select("id")
      .single();
    if (error) throw error;
    docId = (data as { id: string }).id;
  }

  if (!docId) throw new Error("document id を取得できませんでした");

  // services: 既存全削除 → 再 INSERT (steps は cascade で自動削除)
  const { error: delSvcErr } = await supabase
    .from("kaigo_visit_procedure_services")
    .delete()
    .eq("document_id", docId);
  if (delSvcErr) throw delSvcErr;

  // service_kind 必須なので空サービスは skip
  const insertableServices = doc.services.filter(
    (s) => (s.service_kind && s.service_kind.length > 0) || (s.time_range && s.time_range.length > 0) || s.steps.length > 0,
  );

  for (const svc of insertableServices) {
    const { data: newSvc, error: svcErr } = await supabase
      .from("kaigo_visit_procedure_services")
      .insert({
        document_id: docId,
        service_no: svc.service_no,
        time_range: svc.time_range || null,
        // service_kind NOT NULL なので空なら placeholder. UI 側で必須にしているが保険.
        service_kind: svc.service_kind || "身体1",
        special_notes: svc.special_notes || null,
      })
      .select("id")
      .single();
    if (svcErr) throw svcErr;
    const svcId = (newSvc as { id: string }).id;

    if (svc.steps.length > 0) {
      const stepRows = svc.steps.map((st, idx) => ({
        service_id: svcId,
        step_no: idx + 1,
        content: st.content,
        minutes: Math.max(0, Math.floor(st.minutes ?? 0)),
        detail: st.detail || null,
      }));
      const { error: stepErr } = await supabase
        .from("kaigo_visit_procedure_steps")
        .insert(stepRows);
      if (stepErr) throw stepErr;
    }
  }

  return docId;
}

export async function deleteDocument(supabase: SupabaseClient, id: string): Promise<void> {
  // cascade で services / steps も削除される
  const { error } = await supabase
    .from("kaigo_visit_procedure_documents")
    .delete()
    .eq("id", id);
  if (error) throw error;
}
