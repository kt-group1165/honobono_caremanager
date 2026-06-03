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
  VisitProcedureClient,
  VisitProcedureDocument,
  VisitProcedureDocumentSummary,
  VisitProcedureService,
  VisitProcedureStep,
} from "./types";

// PostgREST 1000 行制限対応 (project_pagination_audit_remaining.md)
const PAGE_LIMIT = 1000;

/**
 * tenant 配下の全 documents を取得 (全 client 横断、新しい計画日順)
 * 内部利用 / クライアント別一覧用 helper の元データ
 */
export async function getDocuments(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<VisitProcedureDocumentSummary[]> {
  const all: VisitProcedureDocumentSummary[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("kaigo_visit_procedure_documents")
      .select("id, client_name, plan_start_date, plan_end_date, author_name, creation_reason, created_at, updated_at")
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

/**
 * 利用者一覧 (DISTINCT client_name) + バージョン数 + 最新計画開始日
 *
 * Phase Perf-1 最適化:
 *   集約に不要な列 (author_name / creation_reason / id 等) は引かず、
 *   client_name と plan_start_date のみ取得して payload 縮小。
 *   getDocuments と独立した軽量フェッチに分離。
 */
export async function getClients(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<VisitProcedureClient[]> {
  const all: { client_name: string; plan_start_date: string }[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("kaigo_visit_procedure_documents")
      .select("client_name, plan_start_date")  // ← 2 列のみ
      .eq("tenant_id", tenantId)
      .range(from, from + PAGE_LIMIT - 1);
    if (error) throw error;
    const rows = (data ?? []) as { client_name: string; plan_start_date: string }[];
    all.push(...rows);
    if (rows.length < PAGE_LIMIT) break;
    from += PAGE_LIMIT;
  }

  const map = new Map<string, VisitProcedureClient>();
  for (const d of all) {
    const cur = map.get(d.client_name);
    if (!cur) {
      map.set(d.client_name, {
        client_name: d.client_name,
        version_count: 1,
        latest_plan_start_date: d.plan_start_date,
      });
    } else {
      cur.version_count += 1;
      if (d.plan_start_date > cur.latest_plan_start_date) cur.latest_plan_start_date = d.plan_start_date;
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    b.latest_plan_start_date.localeCompare(a.latest_plan_start_date) ||
    a.client_name.localeCompare(b.client_name, "ja"),
  );
}

/**
 * 指定 client_name のバージョン一覧 (新しい計画開始日順)
 */
export async function getDocumentsByClient(
  supabase: SupabaseClient,
  tenantId: string,
  clientName: string,
): Promise<VisitProcedureDocumentSummary[]> {
  const { data, error } = await supabase
    .from("kaigo_visit_procedure_documents")
    .select("id, client_name, plan_start_date, plan_end_date, author_name, creation_reason, created_at, updated_at")
    .eq("tenant_id", tenantId)
    .eq("client_name", clientName)
    .order("plan_start_date", { ascending: false });
  if (error) throw error;
  return (data ?? []) as VisitProcedureDocumentSummary[];
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
    plan_end_date: doc.plan_end_date,
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
