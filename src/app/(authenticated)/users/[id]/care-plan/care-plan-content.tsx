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
  Archive,
  Printer,
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

// 同じ送信元から短時間に届いた 1-3表 を 1 グループにまとめる
interface ReceivedCarePlanGroup {
  groupKey: string;
  sourceOfficeId: string;
  sourceOfficeName: string;
  sentAt: string; // 最古の sent_at
  items: ReceivedCarePlan[];
  allImported: boolean;
  anyImported: boolean;
}

// (source_office_id, target, client, sent_at ± 5 分) でグループ化
const GROUP_WINDOW_MS = 5 * 60 * 1000;

function groupReceivedPlans(rows: ReceivedCarePlan[]): ReceivedCarePlanGroup[] {
  // sent_at 昇順で並べてから走査 (近い時刻のものを同じグループに)
  const sorted = [...rows].sort((a, b) =>
    a.shared.sent_at < b.shared.sent_at ? -1 : 1,
  );
  const groups: ReceivedCarePlanGroup[] = [];
  for (const r of sorted) {
    const t = new Date(r.shared.sent_at).getTime();
    // 同 source × 時刻近い既存グループを探す
    const g = groups.find(
      (gg) =>
        gg.sourceOfficeId === r.shared.source_office_id &&
        Math.abs(new Date(gg.sentAt).getTime() - t) <= GROUP_WINDOW_MS,
    );
    if (g) {
      g.items.push(r);
    } else {
      groups.push({
        groupKey: `${r.shared.source_office_id}_${r.shared.sent_at}`,
        sourceOfficeId: r.shared.source_office_id,
        sourceOfficeName: r.sourceOfficeName,
        sentAt: r.shared.sent_at,
        items: [r],
        allImported: false,
        anyImported: false,
      });
    }
  }
  // 各グループ: items を report_type 順に sort、imported フラグ集約
  for (const g of groups) {
    g.items.sort((a, b) =>
      a.shared.document_type < b.shared.document_type ? -1 : 1,
    );
    g.allImported = g.items.every((i) => i.imported);
    g.anyImported = g.items.some((i) => i.imported);
  }
  // 最新グループを上に
  return groups.sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));
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

  const groups = useMemo(() => groupReceivedPlans(items), [items]);

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

  const handleImportGroup = async (g: ReceivedCarePlanGroup) => {
    // 再取込なら全件、未取込なら未取込分のみを対象
    const targets = g.allImported ? g.items : g.items.filter((i) => !i.imported);
    if (targets.length === 0) return;
    const labels = targets
      .map((t) => CARE_PLAN_LABEL[t.shared.document_type] ?? t.shared.document_type)
      .join(" / ");
    if (!window.confirm(
      `${g.sourceOfficeName} から届いた以下を取り込みます:\n` +
      `  ${labels}\n` +
      `(自事業所のケアプラン帳票として保存し、後から閲覧/印刷できるようになります)`,
    )) return;

    setImportingId(g.groupKey);
    try {
      // 各帳票を順に INSERT (失敗時は途中まで成功した分は残る)
      for (const t of targets) {
        const content: Record<string, unknown> = {
          html_snapshot: t.shared.html_content,
          imported_from_shared_doc_id: t.shared.id,
          source_office_id: t.shared.source_office_id,
          source_office_name: t.sourceOfficeName,
          received_at: t.shared.sent_at,
          ...(t.shared.payload && typeof t.shared.payload === "object" ? t.shared.payload : {}),
        };
        const title = `${t.shared.title}(取込：${t.sourceOfficeName})`;
        const { error } = await supabase.from("kaigo_report_documents").insert({
          user_id: clientId,
          report_type: t.shared.document_type,
          title,
          report_month: null,
          content,
          status: "draft",
        });
        if (error) throw error;
      }
      toast.success(`${targets.length} 帳票を取り込みました`);
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("取り込みに失敗: " + msg);
    } finally {
      setImportingId(null);
    }
  };

  if (!clientId || !targetOfficeId) return null;

  const pendingGroupCount = groups.filter((g) => !g.allImported).length;

  return (
    <div className="rounded-lg border bg-white shadow-sm">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
          <Inbox size={14} className="text-blue-600" />
          受信ケアプラン
          {pendingGroupCount > 0 && (
            <span className="rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-bold text-white">
              未取込 {pendingGroupCount}
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

      {loading && groups.length === 0 ? (
        <div className="flex items-center justify-center py-6 text-gray-400">
          <Loader2 size={16} className="mr-2 animate-spin" /> 読込中...
        </div>
      ) : groups.length === 0 ? (
        <div className="px-4 py-5 text-center text-xs text-gray-400">
          この利用者宛ての受信ケアプランはありません
        </div>
      ) : (
        <ul className="divide-y">
          {groups.map((g) => {
            // 各帳票種別の取込状態を short label で表示
            const docBadges = g.items.map((it) => ({
              label:
                (CARE_PLAN_LABEL[it.shared.document_type] ?? it.shared.document_type)
                  .split(" ")[0], // "第1表"
              imported: it.imported,
              shared: it.shared,
            }));
            return (
              <li
                key={g.groupKey}
                className={`flex items-center justify-between gap-3 px-4 py-2.5 ${g.allImported ? "bg-gray-50" : "bg-blue-50/40"}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-gray-800">
                      {g.sourceOfficeName}
                    </span>
                    {g.allImported ? (
                      <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
                        取込済
                      </span>
                    ) : g.anyImported ? (
                      <span className="rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                        一部未取込
                      </span>
                    ) : (
                      <span className="rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                        未取込
                      </span>
                    )}
                    {/* 含まれる帳票バッジ (clickable でプレビュー) */}
                    {docBadges.map((b) => (
                      <button
                        key={b.shared.id}
                        type="button"
                        onClick={() => setPreviewing(b.shared)}
                        className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                          b.imported
                            ? "bg-gray-100 text-gray-600 hover:bg-gray-200"
                            : "bg-blue-100 text-blue-700 hover:bg-blue-200"
                        }`}
                        title={`${b.label} をプレビュー${b.imported ? " (取込済)" : ""}`}
                      >
                        {b.label}
                        {b.imported && <Eye size={10} className="ml-0.5 opacity-60" />}
                      </button>
                    ))}
                  </div>
                  <div className="mt-0.5 text-[11px] text-gray-500 truncate">
                    送信: {format(parseISO(g.sentAt), "yyyy/MM/dd HH:mm", { locale: ja })}
                    {g.items.length > 1 && (
                      <span className="ml-1">・{g.items.length} 帳票一括</span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleImportGroup(g)}
                    disabled={importingId === g.groupKey}
                    className={`inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                      g.allImported
                        ? "border border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
                        : "bg-blue-600 text-white hover:bg-blue-700"
                    }`}
                    title={g.allImported ? "再度取り込んで新しい帳票として保存" : "未取込分を自事業所の帳票として保存"}
                  >
                    {importingId === g.groupKey ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Download size={12} />
                    )}
                    {g.allImported
                      ? `再取込 (${g.items.length})`
                      : `取込 (${g.items.filter((i) => !i.imported).length})`}
                  </button>
                </div>
              </li>
            );
          })}
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

// ─── 取込済ケアプラン (= 自事業所が保管しているケアプラン帳票) パネル ─────

interface StoredCarePlan {
  id: string;
  report_type: string;
  title: string;
  status: "draft" | "completed";
  updated_at: string;
  source_office_name: string | null;
  received_at: string | null;
  html_snapshot: string | null;
}

// 保管中も同じくグループ化 (送信元 + received_at ±5 分)
interface StoredCarePlanGroup {
  groupKey: string;
  sourceOfficeName: string | null;
  receivedAt: string | null;
  latestUpdatedAt: string;
  items: StoredCarePlan[];
}

function groupStoredPlans(rows: StoredCarePlan[]): StoredCarePlanGroup[] {
  const sorted = [...rows].sort((a, b) => {
    const at = a.received_at ?? a.updated_at;
    const bt = b.received_at ?? b.updated_at;
    return at < bt ? -1 : 1;
  });
  const groups: StoredCarePlanGroup[] = [];
  for (const r of sorted) {
    const t = new Date(r.received_at ?? r.updated_at).getTime();
    const g = groups.find(
      (gg) =>
        gg.sourceOfficeName === r.source_office_name &&
        Math.abs(
          new Date(gg.receivedAt ?? gg.latestUpdatedAt).getTime() - t,
        ) <= GROUP_WINDOW_MS,
    );
    if (g) {
      g.items.push(r);
      if (r.updated_at > g.latestUpdatedAt) g.latestUpdatedAt = r.updated_at;
    } else {
      groups.push({
        groupKey: `${r.source_office_name ?? "_"}_${r.received_at ?? r.updated_at}_${r.id}`,
        sourceOfficeName: r.source_office_name,
        receivedAt: r.received_at,
        latestUpdatedAt: r.updated_at,
        items: [r],
      });
    }
  }
  for (const g of groups) {
    g.items.sort((a, b) => (a.report_type < b.report_type ? -1 : 1));
  }
  return groups.sort((a, b) => (a.latestUpdatedAt < b.latestUpdatedAt ? 1 : -1));
}

function StoredCarePlansPanel({ clientId }: { clientId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [items, setItems] = useState<StoredCarePlan[]>([]);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState<StoredCarePlan | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const groups = useMemo(() => groupStoredPlans(items), [items]);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("kaigo_report_documents")
        .select("id, report_type, title, status, updated_at, content")
        .eq("user_id", clientId)
        .in("report_type", CARE_PLAN_REPORT_TYPES as unknown as string[])
        .order("updated_at", { ascending: false });
      if (error) {
        toast.error("保管中ケアプランの取得に失敗しました");
        return;
      }
      const rows = (data ?? []) as Array<{
        id: string;
        report_type: string;
        title: string;
        status: "draft" | "completed";
        updated_at: string;
        content: unknown;
      }>;
      setItems(
        rows.map<StoredCarePlan>((r) => {
          const c = (r.content ?? {}) as Record<string, unknown>;
          return {
            id: r.id,
            report_type: r.report_type,
            title: r.title,
            status: r.status,
            updated_at: r.updated_at,
            source_office_name:
              typeof c.source_office_name === "string" ? c.source_office_name : null,
            received_at: typeof c.received_at === "string" ? c.received_at : null,
            html_snapshot:
              typeof c.html_snapshot === "string" ? c.html_snapshot : null,
          };
        }),
      );
    } finally {
      setLoading(false);
    }
  }, [supabase, clientId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch)
    refresh();
  }, [refresh]);

  const handleDeleteGroup = async (g: StoredCarePlanGroup) => {
    const labels = g.items
      .map((i) => CARE_PLAN_LABEL[i.report_type] ?? i.report_type)
      .join(" / ");
    if (!window.confirm(
      `${g.sourceOfficeName ?? "—"} から取り込んだ以下の帳票を削除します:\n` +
      `  ${labels}\n` +
      `(${g.items.length} 帳票)`,
    )) return;
    setDeletingId(g.groupKey);
    try {
      const ids = g.items.map((i) => i.id);
      const { error } = await supabase
        .from("kaigo_report_documents")
        .delete()
        .in("id", ids);
      if (error) throw error;
      toast.success(`${ids.length} 帳票を削除しました`);
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("削除に失敗: " + msg);
    } finally {
      setDeletingId(null);
    }
  };

  if (!clientId) return null;

  return (
    <div className="rounded-lg border bg-white shadow-sm">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
          <Archive size={14} className="text-emerald-600" />
          保管中ケアプラン ({groups.length} 件 / {items.length} 帳票)
        </h2>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="text-xs text-gray-500 hover:text-emerald-600 disabled:opacity-50"
        >
          {loading ? "読込中..." : "再読込"}
        </button>
      </div>

      {loading && groups.length === 0 ? (
        <div className="flex items-center justify-center py-6 text-gray-400">
          <Loader2 size={16} className="mr-2 animate-spin" /> 読込中...
        </div>
      ) : groups.length === 0 ? (
        <div className="px-4 py-5 text-center text-xs text-gray-400">
          まだ取り込んだケアプランはありません
        </div>
      ) : (
        <ul className="divide-y">
          {groups.map((g) => (
            <li
              key={g.groupKey}
              className="flex items-center justify-between gap-3 px-4 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium text-gray-800">
                    {g.sourceOfficeName ?? "—"}
                  </span>
                  {/* 各帳票を clickable バッジで */}
                  {g.items.map((it) => {
                    const label = (CARE_PLAN_LABEL[it.report_type] ?? it.report_type).split(" ")[0];
                    return (
                      <button
                        key={it.id}
                        type="button"
                        onClick={() => setPreviewing(it)}
                        disabled={!it.html_snapshot}
                        className="inline-flex items-center gap-0.5 rounded bg-emerald-100 text-emerald-700 px-1.5 py-0.5 text-[10px] font-medium hover:bg-emerald-200 disabled:opacity-40 disabled:cursor-not-allowed"
                        title={it.html_snapshot ? `${label} を表示` : "html_snapshot なし"}
                      >
                        {label}
                        <Eye size={10} className="ml-0.5 opacity-60" />
                      </button>
                    );
                  })}
                </div>
                <div className="mt-0.5 text-[11px] text-gray-500 truncate">
                  {g.receivedAt && (
                    <span>
                      受信: {format(parseISO(g.receivedAt), "yyyy/MM/dd HH:mm", { locale: ja })} ・{" "}
                    </span>
                  )}
                  保存: {format(parseISO(g.latestUpdatedAt), "yyyy/MM/dd HH:mm", { locale: ja })}
                  {g.items.length > 1 && <span className="ml-1">・{g.items.length} 帳票一括</span>}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handleDeleteGroup(g)}
                  disabled={deletingId === g.groupKey}
                  className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
                  title="このグループのケアプランを一括削除"
                >
                  {deletingId === g.groupKey ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Trash2 size={12} />
                  )}
                  削除 ({g.items.length})
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {previewing && previewing.html_snapshot && (
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
                    if (w && previewing.html_snapshot) {
                      w.document.write(previewing.html_snapshot);
                      w.document.close();
                    }
                  }}
                  className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                  title="新しいタブで開く"
                >
                  <ExternalLink size={12} />
                  別タブで開く
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const iframe = document.getElementById(
                      "stored-care-plan-iframe",
                    ) as HTMLIFrameElement | null;
                    if (iframe?.contentWindow) iframe.contentWindow.print();
                  }}
                  className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1.5 text-xs text-white hover:bg-blue-700"
                >
                  <Printer size={12} />
                  印刷
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
              id="stored-care-plan-iframe"
              srcDoc={previewing.html_snapshot}
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

      {/* 取込済 = 自事業所が保管しているケアプラン帳票 — 全 mode で表示 */}
      <StoredCarePlansPanel clientId={userId} />

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
