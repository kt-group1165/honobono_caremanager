"use client";

import Link from "next/link";
import { useEffect, useState, useMemo } from "react";
import { BookOpen, Plus, Trash2, Edit3, AlertCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { getDocuments, deleteDocument } from "@/lib/visit-procedure/queries";
import type { VisitProcedureDocumentSummary } from "@/lib/visit-procedure/types";

export default function VisitProceduresListPage() {
  const supabase = useMemo(() => createClient(), []);
  const { businessType, currentOffice, loading: btLoading } = useBusinessType();
  const [docs, setDocs] = useState<VisitProcedureDocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const tenantId = currentOffice?.tenant_id ?? null;

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- mount-time async fetch (HANDOVER §2) */
    if (btLoading) return;
    if (!tenantId) {
      setLoading(false);
      setDocs([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const rows = await getDocuments(supabase, tenantId);
        if (!cancelled) setDocs(rows);
      } catch (err) {
        console.error(err);
        toast.error("手順書の読込に失敗しました: " + (err instanceof Error ? err.message : String(err)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [supabase, tenantId, btLoading]);

  const handleDelete = async (id: string, clientName: string) => {
    if (!confirm(`「${clientName}」の手順書を削除します。よろしいですか？`)) return;
    setDeletingId(id);
    try {
      await deleteDocument(supabase, id);
      setDocs((prev) => prev.filter((d) => d.id !== id));
      toast.success("手順書を削除しました");
    } catch (err) {
      console.error(err);
      toast.error("削除に失敗しました: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setDeletingId(null);
    }
  };

  const officeQuery = currentOffice ? `?office=${encodeURIComponent(currentOffice.id)}` : "";

  // 訪問介護以外の事業種別では表示制限
  if (!btLoading && businessType !== "訪問介護") {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">手順書</h1>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-amber-800 flex items-start gap-3">
          <AlertCircle size={20} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">この機能は訪問介護モード専用です</p>
            <p className="text-sm mt-1">サイドバー下部の事業所セレクタから訪問介護の自事業所を選択してください。</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <BookOpen size={24} className="text-green-600" />
            手順書
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            訪問介護のサービス手順書 (週次表 + サービス毎ステップ + モジュール表示)
          </p>
        </div>
        <Link
          href={`/visit-procedures/new${officeQuery}`}
          className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-green-700"
        >
          <Plus size={16} />
          新規作成
        </Link>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-gray-400">
          <Loader2 size={20} className="animate-spin mr-2" />
          読込中...
        </div>
      ) : docs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-12 text-center">
          <BookOpen size={40} className="mx-auto mb-3 text-gray-300" />
          <p className="text-sm text-gray-500">手順書はまだ登録されていません</p>
          <p className="text-xs text-gray-400 mt-1">右上の「新規作成」から作成してください</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">利用者名</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">計画開始日</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">作成者</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">作成理由</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">更新日時</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {docs.map((doc) => (
                <tr key={doc.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">{doc.client_name}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">{doc.plan_start_date}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">{doc.author_name || "-"}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">{doc.creation_reason || "-"}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {doc.updated_at ? new Date(doc.updated_at).toLocaleString("ja-JP") : "-"}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <Link
                      href={`/visit-procedures/${doc.id}${officeQuery}`}
                      className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50"
                    >
                      <Edit3 size={14} />
                      編集
                    </Link>
                    <button
                      onClick={() => handleDelete(doc.id, doc.client_name)}
                      disabled={deletingId === doc.id}
                      className="ml-2 inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      {deletingId === doc.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                      削除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
