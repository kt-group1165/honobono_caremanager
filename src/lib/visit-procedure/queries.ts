/**
 * 訪問介護 手順書 機能の Supabase queries (v2)
 *
 * 3 table を協調操作:
 *  - kaigo_visit_procedure_documents
 *  - kaigo_visit_procedure_services
 *  - kaigo_visit_procedure_steps
 *
 * + app_settings (= step 所要時間プルダウン上限など)
 *
 * v2 変更:
 *  - services から time_range を送信しない (= column drop 済)
 *  - 複製機能 3 種 (document / service / step) は呼出側で処理 — DB 層は document 複製のみ提供
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  emptyWeeklyRow,
  WEEKDAY_KEYS,
  SERVICE_NOS,
  type VisitProcedureClient,
  type VisitProcedureDocument,
  type VisitProcedureDocumentSummary,
  type VisitProcedureService,
  type VisitProcedureStep,
  type VisitProcedureStepTemplate,
  type WeeklyRow,
  type WeeklySchedule,
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

/** weekly_schedule を v2 構造に正規化 (= 旧構造や null/欠損を空 row で埋める) */
function normalizeWeeklySchedule(raw: unknown): WeeklySchedule {
  const out: WeeklySchedule = {};
  const obj = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<string, unknown>;
  for (const day of WEEKDAY_KEYS) {
    const v = obj[day];
    if (Array.isArray(v) && v.length > 0) {
      out[day] = v.map((row) => {
        if (!row || typeof row !== "object") return emptyWeeklyRow();
        const r = row as Record<string, unknown>;
        const newRow: WeeklyRow = {};
        for (const no of SERVICE_NOS) {
          const cell = r[String(no)];
          if (cell && typeof cell === "object" && typeof (cell as { start?: unknown }).start === "string") {
            newRow[String(no)] = { start: (cell as { start: string }).start };
          } else {
            newRow[String(no)] = null;
          }
        }
        return newRow;
      });
    } else {
      out[day] = [emptyWeeklyRow()];
    }
  }
  return out;
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

  const docTyped = doc as Omit<VisitProcedureDocument, "services" | "weekly_schedule"> & {
    weekly_schedule?: unknown;
  };

  return {
    ...docTyped,
    weekly_schedule: normalizeWeeklySchedule(docTyped.weekly_schedule),
    services: fullServices,
  };
}

/**
 * document 一括 upsert (v2)
 *  - documents: id 有なら UPDATE / 無なら INSERT (id 返却)
 *  - services: 既存全 DELETE → 5 サービス INSERT (空でも)
 *  - steps: services と同様に DELETE → INSERT
 *
 * 注意: services の time_range は送信しない (= column drop 済)
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

  // service_kind 必須なので空サービスは skip (= UI 側で未選択 block 済だが保険)
  const insertableServices = doc.services.filter(
    (s) => (s.service_kind && s.service_kind.length > 0) || s.steps.length > 0,
  );

  for (const svc of insertableServices) {
    const { data: newSvc, error: svcErr } = await supabase
      .from("kaigo_visit_procedure_services")
      .insert({
        document_id: docId,
        service_no: svc.service_no,
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

// ─────────────────────────────────────────────────────
// 複製機能 (v2)
// ─────────────────────────────────────────────────────

/**
 * 既存 document を「同じ利用者の新バージョン」として複製
 *  - client_name 同じ / plan_start_date は引数で上書き
 *  - services + steps も DB から取り直して新規 id で挿入
 *  - 戻り値: 新 document id
 */
export async function duplicateDocumentToNewVersion(
  supabase: SupabaseClient,
  sourceId: string,
  newPlanStartDate: string,
): Promise<string> {
  const src = await getDocument(supabase, sourceId);
  if (!src) throw new Error("複製元の手順書が見つかりません");
  const clone: VisitProcedureDocument = {
    ...src,
    id: undefined,
    plan_start_date: newPlanStartDate,
    plan_end_date: null,
    creation_reason: src.creation_reason ? `${src.creation_reason} (複製)` : "複製",
    services: src.services.map((s) => ({
      ...s,
      id: undefined,
      document_id: undefined,
      steps: s.steps.map((st) => ({ ...st, id: undefined, service_id: undefined })),
    })),
  };
  return saveDocument(supabase, clone);
}

/**
 * 既存 document を「別の利用者にコピー」
 *  - client_name のみ差替え、他は同一
 */
export async function duplicateDocumentToAnotherClient(
  supabase: SupabaseClient,
  sourceId: string,
  newClientName: string,
): Promise<string> {
  const src = await getDocument(supabase, sourceId);
  if (!src) throw new Error("複製元の手順書が見つかりません");
  const trimmed = newClientName.trim();
  if (!trimmed) throw new Error("コピー先の利用者名が空です");
  const clone: VisitProcedureDocument = {
    ...src,
    id: undefined,
    client_name: trimmed,
    creation_reason: src.creation_reason ? `${src.creation_reason} (他利用者から複製)` : "他利用者から複製",
    services: src.services.map((s) => ({
      ...s,
      id: undefined,
      document_id: undefined,
      steps: s.steps.map((st) => ({ ...st, id: undefined, service_id: undefined })),
    })),
  };
  return saveDocument(supabase, clone);
}

// ─────────────────────────────────────────────────────
// app_settings (= step 所要時間プルダウン上限など)
// ─────────────────────────────────────────────────────

const SETTING_KEY_STEP_DURATION_MAX = "visit_procedure_step_duration_max";

/**
 * step 所要時間プルダウン上限 (default 60) を取得
 * row が無い・型不正 / 取得失敗時は default 60 を返す (= 機能停止を防ぐ)
 */
export async function getStepDurationMax(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", SETTING_KEY_STEP_DURATION_MAX)
    .maybeSingle();
  if (error) {
    console.warn("getStepDurationMax fetch failed:", error.message);
    return 60;
  }
  const v = (data as { value?: unknown } | null)?.value;
  if (typeof v === "number" && Number.isFinite(v) && v >= 5) return Math.floor(v / 5) * 5;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 5) return Math.floor(n / 5) * 5;
  }
  return 60;
}

/**
 * step 所要時間プルダウン上限を保存 (upsert)
 */
export async function setStepDurationMax(
  supabase: SupabaseClient,
  newMaxMinutes: number,
): Promise<void> {
  const m = Math.max(5, Math.floor(newMaxMinutes / 5) * 5);
  const { error } = await supabase
    .from("app_settings")
    .upsert(
      { key: SETTING_KEY_STEP_DURATION_MAX, value: m },
      { onConflict: "key" },
    );
  if (error) throw error;
}

// ─────────────────────────────────────────────────────
// step テンプレート (= サービス内容 + 具体的取り組内容 の master)
// ─────────────────────────────────────────────────────

/**
 * 指定 office の step テンプレート一覧 (soft delete 済を除外、sort_order → name 順)
 */
export async function getStepTemplates(
  supabase: SupabaseClient,
  officeId: string,
): Promise<VisitProcedureStepTemplate[]> {
  const { data, error } = await supabase
    .from("kaigo_visit_procedure_step_templates")
    .select("*")
    .eq("office_id", officeId)
    .is("deleted_at", null)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (error) throw error;
  return (data ?? []) as VisitProcedureStepTemplate[];
}

/**
 * step テンプレート 新規作成
 *  - UNIQUE (office_id, name) 違反は "同名のテンプレートが既に登録されています" として返す
 *  - 戻り値: 新 row
 */
export async function createStepTemplate(
  supabase: SupabaseClient,
  payload: {
    office_id: string;
    tenant_id: string;
    name: string;
    detail: string | null;
    sort_order?: number;
  },
): Promise<VisitProcedureStepTemplate> {
  const insert = {
    office_id: payload.office_id,
    tenant_id: payload.tenant_id,
    name: payload.name,
    detail: payload.detail,
    sort_order: payload.sort_order ?? 0,
  };
  const { data, error } = await supabase
    .from("kaigo_visit_procedure_step_templates")
    .insert(insert)
    .select("*")
    .single();
  if (error) {
    // UNIQUE 違反 (= 23505) は専用メッセージに置き換える
    if (error.code === "23505") {
      throw new Error(`同名のテンプレートが既に登録されています: ${payload.name}`);
    }
    throw error;
  }
  return data as VisitProcedureStepTemplate;
}

/**
 * step テンプレート 部分更新
 *  - patch に含めた列のみ更新
 *  - UNIQUE 違反は専用メッセージ
 */
export async function updateStepTemplate(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<Pick<VisitProcedureStepTemplate, "name" | "detail" | "sort_order">>,
): Promise<VisitProcedureStepTemplate> {
  const { data, error } = await supabase
    .from("kaigo_visit_procedure_step_templates")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      throw new Error(`同名のテンプレートが既に登録されています: ${patch.name ?? ""}`);
    }
    throw error;
  }
  return data as VisitProcedureStepTemplate;
}

/**
 * step テンプレート soft delete (= deleted_at = NOW())
 *  - 既存 手順書には影響しない (= テキスト一致なので)
 */
export async function softDeleteStepTemplate(
  supabase: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await supabase
    .from("kaigo_visit_procedure_step_templates")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/**
 * 全手順書から step.minutes の最大値を取得 (= 上限変更 disable 判定用)
 *  - tenant_id 指定で絞り込み
 *  - service_id IN (...) でまとめて取る (page 分割)
 */
export async function getMaxStepMinutesForTenant(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<number> {
  // doc → service → step の順で取得
  const docIds: string[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("kaigo_visit_procedure_documents")
      .select("id")
      .eq("tenant_id", tenantId)
      .range(from, from + PAGE_LIMIT - 1);
    if (error) throw error;
    const rows = (data ?? []) as { id: string }[];
    docIds.push(...rows.map((r) => r.id));
    if (rows.length < PAGE_LIMIT) break;
    from += PAGE_LIMIT;
  }
  if (docIds.length === 0) return 0;

  const svcIds: string[] = [];
  // doc id を 200 件ずつ in() で分割
  const chunkSize = 200;
  for (let i = 0; i < docIds.length; i += chunkSize) {
    const chunk = docIds.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from("kaigo_visit_procedure_services")
      .select("id")
      .in("document_id", chunk);
    if (error) throw error;
    svcIds.push(...((data ?? []) as { id: string }[]).map((r) => r.id));
  }
  if (svcIds.length === 0) return 0;

  let maxMin = 0;
  for (let i = 0; i < svcIds.length; i += chunkSize) {
    const chunk = svcIds.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from("kaigo_visit_procedure_steps")
      .select("minutes")
      .in("service_id", chunk)
      .order("minutes", { ascending: false })
      .limit(1);
    if (error) throw error;
    const top = ((data ?? []) as { minutes: number }[])[0]?.minutes ?? 0;
    if (top > maxMin) maxMin = top;
  }
  return maxMin;
}
