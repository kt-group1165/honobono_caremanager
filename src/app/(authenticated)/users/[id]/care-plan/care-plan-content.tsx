"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { format, parseISO } from "date-fns";
import { ja } from "date-fns/locale";
import {
  Plus,
  Save,
  Trash2,
  Loader2,
  FileText,
  ClipboardList,
  CalendarDays,
  Activity,
  ExternalLink,
  Inbox,
  Download,
  Eye,
} from "lucide-react";
import type { CarePlan } from "@/types/database";
import { useBusinessType } from "@/lib/business-type-context";
import type { SharedDocumentRow } from "@/lib/notifications";

const STATUS_OPTIONS: CarePlan["status"][] = ["draft", "active", "completed", "cancelled"];

const STATUS_LABELS: Record<CarePlan["status"], string> = {
  draft: "下書き",
  active: "有効",
  completed: "完了",
  cancelled: "中止",
};

const STATUS_COLORS: Record<CarePlan["status"], string> = {
  draft: "bg-yellow-100 text-yellow-700",
  active: "bg-green-100 text-green-700",
  completed: "bg-gray-200 text-gray-600",
  cancelled: "bg-red-100 text-red-600",
};

interface CarePlanContentProps {
  userId: string;
  initialPlans: CarePlan[];
}

type FormState = {
  start_date: string;
  end_date: string;
  plan_type: string;
  status: CarePlan["status"];
  long_term_goals: string;
  short_term_goals: string;
};

const EMPTY_FORM: FormState = {
  start_date: "",
  end_date: "",
  plan_type: "居宅サービス計画",
  status: "active",
  long_term_goals: "",
  short_term_goals: "",
};

// ─── 受信ケアプラン (居宅 → 自事業所) の取込パネル ────────────────────────────

const CARE_PLAN_REPORT_TYPES = ["care-plan-1", "care-plan-2", "care-plan-3"] as const;
const CARE_PLAN_LABEL: Record<string, string> = {
  "care-plan-1": "第1表 (居宅サービス計画書1)",
  "care-plan-2": "第2表 (居宅サービス計画書2)",
  "care-plan-3": "第3表 (週間サービス計画表)",
};

interface ReceivedCarePlan {
  shared: SharedDocumentRow;
  sourceOfficeName: string;
  imported: boolean;
}

function ReceivedCarePlansPanel({
  clientId,
  targetOfficeId,
}: {
  clientId: string;
  targetOfficeId: string | null;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [items, setItems] = useState<ReceivedCarePlan[]>([]);
  const [loading, setLoading] = useState(false);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<SharedDocumentRow | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId || !targetOfficeId) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      // 1. shared_documents 取得 (3 種別 + 自 office 宛て)
      const { data: shared, error } = await supabase
        .from("shared_documents")
        .select(
          "id, tenant_id, client_id, source_office_id, target_office_id, document_type, title, html_content, payload, source_document_id, sent_at, sent_by, read_at, read_by, created_at",
        )
        .eq("client_id", clientId)
        .eq("target_office_id", targetOfficeId)
        .in("document_type", CARE_PLAN_REPORT_TYPES as unknown as string[])
        .order("sent_at", { ascending: false });
      if (error) {
        toast.error("受信ケアプランの取得に失敗しました");
        return;
      }
      const rows = (shared ?? []) as SharedDocumentRow[];

      // 2. 既存 kaigo_report_documents を取得し、content.imported_from_shared_doc_id を Set 化
      const { data: docs } = await supabase
        .from("kaigo_report_documents")
        .select("id, content")
        .eq("user_id", clientId)
        .in("report_type", CARE_PLAN_REPORT_TYPES as unknown as string[]);
      const importedIds = new Set<string>();
      for (const d of (docs ?? []) as Array<{ id: string; content: unknown }>) {
        const c = (d.content ?? {}) as Record<string, unknown>;
        const v = c.imported_from_shared_doc_id;
        if (typeof v === "string") importedIds.add(v);
      }

      // 3. source office 名 fetch
      const sourceIds = Array.from(new Set(rows.map((r) => r.source_office_id)));
      let nameMap = new Map<string, string>();
      if (sourceIds.length > 0) {
        const { data: offices } = await supabase
          .from("offices")
          .select("id, name")
          .in("id", sourceIds);
        nameMap = new Map(
          ((offices ?? []) as Array<{ id: string; name: string }>).map((o) => [o.id, o.name]),
        );
      }

      setItems(
        rows.map<ReceivedCarePlan>((r) => ({
          shared: r,
          sourceOfficeName: nameMap.get(r.source_office_id) ?? "—",
          imported: importedIds.has(r.id),
        })),
      );
    } finally {
      setLoading(false);
    }
  }, [supabase, clientId, targetOfficeId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch)
    refresh();
  }, [refresh]);

  const handleImport = async (rec: ReceivedCarePlan) => {
    if (!window.confirm(
      `「${CARE_PLAN_LABEL[rec.shared.document_type] ?? rec.shared.document_type}」を取り込みます。\n` +
      `(自事業所のケアプラン帳票として保存し、後から閲覧/印刷できるようになります)`,
    )) {
      return;
    }
    setImportingId(rec.shared.id);
    try {
      const content: Record<string, unknown> = {
        // 受信した html を snapshot として保存 (構造化 content は payload に無いので)
        html_snapshot: rec.shared.html_content,
        imported_from_shared_doc_id: rec.shared.id,
        source_office_id: rec.shared.source_office_id,
        source_office_name: rec.sourceOfficeName,
        received_at: rec.shared.sent_at,
        ...(rec.shared.payload && typeof rec.shared.payload === "object" ? rec.shared.payload : {}),
      };
      const title = `${rec.shared.title}（取込：${rec.sourceOfficeName}）`;
      const { error } = await supabase.from("kaigo_report_documents").insert({
        user_id: clientId,
        report_type: rec.shared.document_type,
        title,
        report_month: null,
        content,
        status: "draft",
      });
      if (error) throw error;
      toast.success("ケアプランを取り込みました");
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("取り込みに失敗: " + msg);
    } finally {
      setImportingId(null);
    }
  };

  if (!clientId || !targetOfficeId) return null;

  const pendingCount = items.filter((it) => !it.imported).length;

  return (
    <div className="rounded-lg border bg-white shadow-sm">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
          <Inbox size={14} className="text-blue-600" />
          受信ケアプラン
          {pendingCount > 0 && (
            <span className="rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-bold text-white">
              未取込 {pendingCount}
            </span>
          )}
        </h2>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="text-xs text-gray-500 hover:text-blue-600 disabled:opacity-50"
        >
          {loading ? "読込中..." : "再読込"}
        </button>
      </div>

      {loading && items.length === 0 ? (
        <div className="flex items-center justify-center py-6 text-gray-400">
          <Loader2 size={16} className="mr-2 animate-spin" /> 読込中...
        </div>
      ) : items.length === 0 ? (
        <div className="px-4 py-5 text-center text-xs text-gray-400">
          この利用者宛ての受信ケアプランはありません
        </div>
      ) : (
        <ul className="divide-y">
          {items.map((it) => (
            <li
              key={it.shared.id}
              className={`flex items-center justify-between gap-3 px-4 py-2.5 ${it.imported ? "bg-gray-50" : "bg-blue-50/40"}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-700">
                    {CARE_PLAN_LABEL[it.shared.document_type] ?? it.shared.document_type}
                  </span>
                  <span className="truncate text-sm font-medium text-gray-800">
                    {it.sourceOfficeName}
                  </span>
                  {it.imported ? (
                    <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
                      取込済
                    </span>
                  ) : (
                    <span className="rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      未取込
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[11px] text-gray-500 truncate">
                  {it.shared.title} ・{" "}
                  {format(parseISO(it.shared.sent_at), "yyyy/MM/dd HH:mm", { locale: ja })}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setPreviewing(it.shared)}
                  className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                  title="受信内容をプレビュー"
                >
                  <Eye size={12} />
                  プレビュー
                </button>
                <button
                  type="button"
                  onClick={() => handleImport(it)}
                  disabled={importingId === it.shared.id}
                  className={`inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                    it.imported
                      ? "border border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
                      : "bg-blue-600 text-white hover:bg-blue-700"
                  }`}
                  title={it.imported ? "再度取り込んで新しい帳票として保存" : "受信内容を取り込んで自事業所の帳票として保存"}
                >
                  {importingId === it.shared.id ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Download size={12} />
                  )}
                  {it.imported ? "再取込" : "取込"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {previewing && (
        <div
          className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-2"
          onClick={() => setPreviewing(null)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-[96vw] h-[96vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b flex items-center justify-between shrink-0">
              <h3 className="text-sm font-semibold text-gray-800 truncate">
                {previewing.title}
              </h3>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    const w = window.open("", "_blank");
                    if (w) {
                      w.document.write(previewing.html_content);
                      w.document.close();
                    }
                  }}
                  className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                  title="新しいタブで開く (印刷もここから)"
                >
                  <ExternalLink size={12} />
                  別タブで開く
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewing(null)}
                  className="text-gray-400 hover:text-gray-600 px-2"
                  aria-label="閉じる"
                >
                  ✕
                </button>
              </div>
            </div>
            <iframe
              srcDoc={previewing.html_content}
              sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
              className="flex-1 w-full border-0 bg-white"
              title={previewing.title}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function planToForm(p: CarePlan): FormState {
  return {
    start_date: p.start_date ?? "",
    end_date: p.end_date ?? "",
    plan_type: p.plan_type ?? "居宅サービス計画",
    status: p.status,
    long_term_goals: p.long_term_goals ?? "",
    short_term_goals: p.short_term_goals ?? "",
  };
}

export function CarePlanContent({ userId, initialPlans }: CarePlanContentProps) {
  const supabase = useMemo(() => createClient(), []);
  const { currentOfficeId, businessType } = useBusinessType();
  // 居宅介護支援以外 (訪問介護/通所介護等) は編集不可、受信ケアプランの閲覧のみ
  const isCareManagerSide = businessType === "居宅介護支援";
  const [plans, setPlans] = useState<CarePlan[]>(initialPlans);
  const [selectedId, setSelectedId] = useState<string | null>(initialPlans[0]?.id ?? null);
  const [form, setForm] = useState<FormState>(
    initialPlans[0] ? planToForm(initialPlans[0]) : EMPTY_FORM,
  );
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const selected = plans.find((p) => p.id === selectedId) ?? null;

  const reload = async () => {
    const { data } = await supabase
      .from("kaigo_care_plans")
      .select("*")
      .eq("user_id", userId)
      .order("start_date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });
    const next = (data ?? []) as CarePlan[];
    setPlans(next);
    if (next.length === 0) {
      setSelectedId(null);
      setForm(EMPTY_FORM);
    } else if (!next.some((p) => p.id === selectedId)) {
      setSelectedId(next[0].id);
      setForm(planToForm(next[0]));
    }
  };

  const handleSelect = (p: CarePlan) => {
    setSelectedId(p.id);
    setForm(planToForm(p));
  };

  const handleNew = async () => {
    setCreating(true);
    try {
      const today = new Date().toISOString().split("T")[0];
      // 既存 active を draft 候補にしたければ手動で変更してもらう (自動 close はしない)
      const { data, error } = await supabase
        .from("kaigo_care_plans")
        .insert({
          user_id: userId,
          plan_number: "",
          plan_type: "居宅サービス計画",
          start_date: today,
          end_date: null,
          long_term_goals: "",
          short_term_goals: "",
          status: "draft",
        })
        .select()
        .single();
      if (error) throw error;
      const created = data as CarePlan;
      setPlans((prev) => [created, ...prev]);
      setSelectedId(created.id);
      setForm(planToForm(created));
      toast.success("ケアプランを新規作成しました");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("作成に失敗: " + msg);
    } finally {
      setCreating(false);
    }
  };

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const patch = {
        plan_type: form.plan_type || "居宅サービス計画",
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        status: form.status,
        long_term_goals: form.long_term_goals || null,
        short_term_goals: form.short_term_goals || null,
        updated_at: new Date().toISOString(),
      };
      const { error } = await supabase
        .from("kaigo_care_plans")
        .update(patch)
        .eq("id", selected.id);
      if (error) throw error;
      toast.success("保存しました");
      await reload();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("保存に失敗: " + msg);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    if (!window.confirm("このケアプランを削除します。よろしいですか？")) return;
    setDeleting(true);
    try {
      const { error } = await supabase
        .from("kaigo_care_plans")
        .delete()
        .eq("id", selected.id);
      if (error) throw error;
      toast.success("削除しました");
      await reload();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("削除に失敗: " + msg);
    } finally {
      setDeleting(false);
    }
  };

  // 関連帳票へのクイックリンク (利用者を選択した状態で開く)
  const userParam = `?user=${encodeURIComponent(userId)}`;
  const relatedLinks: { label: string; href: string; icon: typeof FileText; note?: string }[] = [
    { label: "アセスメント", href: `/assessments${userParam}`, icon: ClipboardList },
    { label: "第1表 (居宅サービス計画書1)", href: `/reports/care-plan-1${userParam}`, icon: FileText },
    { label: "第2表 (居宅サービス計画書2)", href: `/reports/care-plan-2${userParam}`, icon: FileText },
    { label: "第3表 (週間サービス計画表)", href: `/reports/care-plan-3${userParam}`, icon: FileText },
    { label: "第4表 (担当者会議の要点)", href: `/meeting-minutes${userParam}`, icon: FileText },
    { label: "第5表 (居宅介護支援経過)", href: `/support-records${userParam}`, icon: FileText },
    { label: "第6表 (利用票・提供票)", href: `/reports/service-usage${userParam}`, icon: FileText, note: "受信実績の取込もここ" },
    { label: "第7表 (利用票別表)", href: `/reports/service-usage-detail${userParam}`, icon: FileText },
    { label: "モニタリング", href: `/monitoring${userParam}`, icon: Activity },
  ];

  return (
    <div className="space-y-4">
      {/* 受信ケアプラン (居宅 → 自事業所) — 全 mode で表示 */}
      <ReceivedCarePlansPanel clientId={userId} targetOfficeId={currentOfficeId} />

      {/* 以下は居宅介護支援 mode でのみ表示 (訪問介護等は閲覧 only) */}
      {!isCareManagerSide ? null : (
      <>
      {/* プラン一覧 + 新規作成 */}
      <div className="rounded-lg border bg-white shadow-sm">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
            <CalendarDays size={14} className="text-blue-600" />
            ケアプラン一覧 ({plans.length} 件)
          </h2>
          <button
            type="button"
            onClick={handleNew}
            disabled={creating}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            新規作成
          </button>
        </div>
        {plans.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-gray-400">
            ケアプランがありません。「新規作成」で作成できます。
          </div>
        ) : (
          <div className="divide-y">
            {plans.map((p) => {
              const isSelected = p.id === selectedId;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleSelect(p)}
                  className={`w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-gray-50 ${isSelected ? "bg-blue-50" : ""}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium text-gray-800">{p.plan_type || "居宅サービス計画"}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_COLORS[p.status]}`}>
                        {STATUS_LABELS[p.status]}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-gray-500">
                      期間: {p.start_date ?? "—"} 〜 {p.end_date ?? "—"}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 計画詳細 */}
      {selected && (
        <div className="rounded-lg border bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">計画詳細</h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting || saving}
                className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                削除
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || deleting}
                className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                保存
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-gray-500">計画区分</label>
              <input
                type="text"
                value={form.plan_type}
                onChange={(e) => setForm((f) => ({ ...f, plan_type: e.target.value }))}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                placeholder="居宅サービス計画"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">状態</label>
              <select
                value={form.status}
                onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as CarePlan["status"] }))}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">開始日</label>
              <input
                type="date"
                value={form.start_date}
                onChange={(e) => setForm((f) => ({ ...f, start_date: e.target.value }))}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">終了日</label>
              <input
                type="date"
                value={form.end_date}
                onChange={(e) => setForm((f) => ({ ...f, end_date: e.target.value }))}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            </div>
            <div className="col-span-2">
              <label className="mb-1 block text-xs text-gray-500">長期目標</label>
              <textarea
                rows={3}
                value={form.long_term_goals}
                onChange={(e) => setForm((f) => ({ ...f, long_term_goals: e.target.value }))}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            </div>
            <div className="col-span-2">
              <label className="mb-1 block text-xs text-gray-500">短期目標</label>
              <textarea
                rows={3}
                value={form.short_term_goals}
                onChange={(e) => setForm((f) => ({ ...f, short_term_goals: e.target.value }))}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            </div>
          </div>
        </div>
      )}

      {/* 関連帳票クイックリンク */}
      <div className="rounded-lg border bg-white shadow-sm">
        <div className="border-b px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
            <ExternalLink size={14} className="text-blue-600" />
            関連帳票・記録
          </h2>
          <p className="mt-0.5 text-[11px] text-gray-500">
            この利用者を選択した状態で各画面に遷移します
          </p>
        </div>
        <ul className="grid grid-cols-1 divide-y md:grid-cols-2 md:divide-x md:divide-y-0">
          {relatedLinks.map((l, idx) => {
            const Icon = l.icon;
            const isLeftCol = idx % 2 === 0;
            return (
              <li
                key={l.href}
                className={`${idx >= 2 ? "md:border-t md:border-gray-200" : ""} ${isLeftCol ? "" : ""}`}
              >
                <Link
                  href={l.href}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-blue-50"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Icon size={14} className="shrink-0 text-gray-400" />
                    <span className="truncate text-gray-800">{l.label}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {l.note && (
                      <span className="text-[10px] text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">
                        {l.note}
                      </span>
                    )}
                    <ExternalLink size={12} className="text-gray-400" />
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
      </>
      )}
    </div>
  );
}
