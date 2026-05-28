"use client";

/**
 * 訪問介護 手順書: 利用者ごとのバージョン一覧 page
 *
 * URL: /visit-procedures/clients/[name]
 *   name = encodeURIComponent された利用者名
 *
 * - 該当利用者の手順書バージョン一覧 (新しい順)
 *   表示形式: 「1  2026年1月1日～2027年12月31日（短期目標更新の為）」
 * - 行クリック → /visit-procedures/[id] (preview)
 * - 新規バージョン作成ボタン
 */

import Link from "next/link";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, BookOpen, Plus, AlertCircle, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { getDocumentsByClient, deleteDocument } from "@/lib/visit-procedure/queries";
import type { VisitProcedureDocumentSummary } from "@/lib/visit-procedure/types";

function formatJpDate(s: string | null | undefined): string {
  if (!s) return "（未設定）";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

export default function VisitProcedureVersionListPage() {
  const router = useRouter();
  const params = useParams<{ name: string }>();
  const search = useSearchParams();
  const supabase = useMemo(() => createClient(), []);
  const { businessType, currentOffice, loading: btLoading } = useBusinessType();
  const [docs, setDocs] = useState<VisitProcedureDocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const clientName = decodeURIComponent(params?.name ?? "");
  const tenantId = currentOffice?.tenant_id ?? null;
  const officeQuery = search?.get("office") ? `?office=${encodeURIComponent(search.get("office")!)}` : "";

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- mount-time async fetch (HANDOVER §2) */
    if (btLoading) return;
    if (!tenantId || !clientName) { setLoading(false); return; }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const rows = await getDocumentsByClient(supabase, tenantId, clientName);
        if (!cancelled) setDocs(rows);
      } catch (err) {
        console.error(err);
        toast.error("バージョン読込失敗: " + (err instanceof Error ? err.message : String(err)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [supabase, tenantId, clientName, btLoading]);

  const handleDelete = async (id: string, label: string) => {
    if (!confirm(`「${label}」を削除します。よろしいですか？`)) return;
    setDeletingId(id);
    try {
      await deleteDocument(supabase, id);
      setDocs((prev) => prev.filter((d) => d.id !== id));
      toast.success("削除しました");
    } catch (err) {
      console.error(err);
      toast.error("削除失敗: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setDeletingId(null);
    }
  };

  const handleCreateNew = () => {
    const sep = officeQuery ? "&" : "?";
    router.push(`/visit-procedures/clients/${encodeURIComponent(clientName)}/new${officeQuery}${sep}name=${encodeURIComponent(clientName)}`);
  };

  if (!btLoading && businessType !== "訪問介護") {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-amber-800 flex items-start gap-3">
        <AlertCircle size={20} className="shrink-0 mt-0.5" />
        <p className="font-medium">この機能は訪問介護モード専用です</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href={`/visit-procedures${officeQuery}`} className="text-gray-400 hover:text-gray-600">
            <ArrowLeft size={20} />
          </Link>
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <BookOpen size={22} className="text-green-600" />
            {clientName} の手順書バージョン
          </h1>
        </div>
        <button
          onClick={handleCreateNew}
          className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
        >
          <Plus size={16} />
          新規バージョン
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-gray-400">
          <Loader2 size={20} className="animate-spin mr-2" />
          読込中...
        </div>
      ) : docs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-12 text-center">
          <BookOpen size={40} className="mx-auto mb-3 text-gray-300" />
          <p className="text-sm text-gray-500">手順書バージョンがありません</p>
          <p className="text-xs text-gray-400 mt-1">右上の「新規バージョン」から作成してください</p>
        </div>
      ) : (
        <div className="space-y-2">
          {docs.map((d, idx) => {
            const versionNo = idx + 1; // 新しい順 = 1, 2, 3...
            const range = `${formatJpDate(d.plan_start_date)}〜${formatJpDate(d.plan_end_date)}`;
            const reason = d.creation_reason ? `（${d.creation_reason}）` : "";
            return (
              <div key={d.id} className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white p-3 hover:border-green-400 hover:shadow-sm transition">
                <span className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-full bg-green-50 text-green-700 text-sm font-medium">
                  {versionNo}
                </span>
                <Link
                  href={`/visit-procedures/${d.id}${officeQuery}`}
                  className="flex-1 min-w-0 flex items-center gap-4"
                >
                  <span className="text-sm font-medium text-gray-900 truncate flex-1 min-w-0">{range}{reason}</span>
                  <span className="shrink-0 text-xs text-gray-500 hidden sm:inline">
                    {d.author_name ? `作成者: ${d.author_name} / ` : ""}更新: {d.updated_at ? new Date(d.updated_at).toLocaleString("ja-JP") : "-"}
                  </span>
                </Link>
                <button
                  onClick={() => handleDelete(d.id, range)}
                  disabled={deletingId === d.id}
                  className="shrink-0 inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                >
                  {deletingId === d.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  削除
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
