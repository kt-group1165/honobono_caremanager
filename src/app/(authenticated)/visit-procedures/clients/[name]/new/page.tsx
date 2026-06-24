"use client";

/**
 * 訪問介護 手順書: 新規バージョン作成 page
 *
 * URL: /visit-procedures/clients/[name]/new?name=<client_name>
 *
 * - 利用者名は params から取得 (新規利用者の場合は ?name= で渡される)
 * - 期間 (開始/終了) + 作成理由 を入力 → 新規 INSERT して /[id]/edit へ
 */

import { useRouter, useParams, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Save, Loader2, BookOpen, Copy, X } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import {
  saveDocument,
  getClients,
  getDocumentsByClient,
  createDocumentFromSource,
} from "@/lib/visit-procedure/queries";
import { emptyDocument, type VisitProcedureClient, type VisitProcedureDocumentSummary } from "@/lib/visit-procedure/types";

export default function VisitProcedureNewVersionPage() {
  const router = useRouter();
  const params = useParams<{ name: string }>();
  const search = useSearchParams();
  const supabase = useMemo(() => createClient(), []);
  const { currentOffice } = useBusinessType();

  const clientName = decodeURIComponent(params?.name ?? "");
  const tenantId = currentOffice?.tenant_id ?? null;
  const officeId = currentOffice?.id ?? null;
  const officeQuery = search?.get("office") ? `?office=${encodeURIComponent(search.get("office")!)}` : "";

  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");

  const [planStart, setPlanStart] = useState(`${yyyy}-${mm}-${dd}`);
  const [planEnd, setPlanEnd] = useState("");
  const [creationReason, setCreationReason] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [creating, setCreating] = useState(false);

  // 他利用者から複製モーダル state
  const [showDup, setShowDup] = useState(false);
  const [clientList, setClientList] = useState<VisitProcedureClient[]>([]);
  const [selectedSrcClient, setSelectedSrcClient] = useState<string>("");
  const [versionList, setVersionList] = useState<VisitProcedureDocumentSummary[]>([]);
  const [selectedSrcDocId, setSelectedSrcDocId] = useState<string>("");
  const [dupLoading, setDupLoading] = useState(false);

  // モーダル開いた時に利用者一覧 fetch
  useEffect(() => {
    if (!showDup) return;
    if (!tenantId) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await getClients(supabase, tenantId);
        if (!cancelled) {
          // 自分自身の name は除外 (= 同 client 内コピーは別ボタン)
          setClientList(rows.filter((r) => r.client_name !== clientName));
        }
      } catch (err) {
        console.warn("利用者一覧取得失敗:", err);
        if (!cancelled) setClientList([]);
      }
    })();
    return () => { cancelled = true; };
  }, [showDup, tenantId, supabase, clientName]);

  // 利用者選択時にバージョン一覧 fetch (= 最新を default 選択)
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- HANDOVER §2 mount-time async fetch */
    if (!selectedSrcClient || !tenantId) {
      setVersionList([]);
      setSelectedSrcDocId("");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const docs = await getDocumentsByClient(supabase, tenantId, selectedSrcClient);
        if (!cancelled) {
          setVersionList(docs);
          setSelectedSrcDocId(docs[0]?.id ?? "");
        }
      } catch (err) {
        console.warn("バージョン一覧取得失敗:", err);
        if (!cancelled) { setVersionList([]); setSelectedSrcDocId(""); }
      }
    })();
    return () => { cancelled = true; };
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [selectedSrcClient, tenantId, supabase]);

  const handleDuplicate = async () => {
    if (!tenantId) { toast.error("事業所が選択されていません"); return; }
    if (!clientName) { toast.error("利用者名が空です"); return; }
    if (!selectedSrcDocId) { toast.error("複製元の手順書を選択してください"); return; }
    setDupLoading(true);
    try {
      const newId = await createDocumentFromSource(supabase, selectedSrcDocId, {
        tenant_id: tenantId,
        office_id: officeId,
        client_name: clientName,
        plan_start_date: planStart,
        plan_end_date: planEnd || null,
        creation_reason: creationReason || `${selectedSrcClient} から複製`,
        author_name: authorName || null,
      });
      toast.success("複製して新規バージョンを作成しました");
      router.push(`/visit-procedures/${newId}/edit${officeQuery}`);
    } catch (err) {
      console.error(err);
      toast.error("複製失敗: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setDupLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!tenantId) {
      toast.error("事業所が選択されていません");
      return;
    }
    if (!clientName) {
      toast.error("利用者名が空です");
      return;
    }
    if (!planStart) {
      toast.error("計画開始日を入力してください");
      return;
    }
    setCreating(true);
    try {
      const doc = {
        ...emptyDocument(tenantId, officeId),
        client_name: clientName,
        plan_start_date: planStart,
        plan_end_date: planEnd || null,
        creation_reason: creationReason || null,
        author_name: authorName || null,
      };
      const id = await saveDocument(supabase, doc);
      toast.success("バージョンを作成しました");
      router.push(`/visit-procedures/${id}/edit${officeQuery}`);
    } catch (err) {
      console.error(err);
      toast.error("作成失敗: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6 max-w-xl">
      <div className="flex items-center gap-3">
        <Link href={`/visit-procedures/clients/${encodeURIComponent(clientName)}${officeQuery}`} className="text-gray-400 hover:text-gray-600">
          <ArrowLeft size={20} />
        </Link>
        <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
          <BookOpen size={22} className="text-green-600" />
          新規バージョン作成
        </h1>
      </div>
      <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
        <div>
          <label className="text-xs text-gray-500 mb-1 block">利用者名</label>
          <div className="text-sm font-medium text-gray-900 bg-gray-50 rounded px-2 py-1.5">{clientName || "（未指定）"}</div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-500 mb-1 block">計画開始日 *</label>
            <input type="date" value={planStart} onChange={(e) => setPlanStart(e.target.value)}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">計画終了日</label>
            <input type="date" value={planEnd} onChange={(e) => setPlanEnd(e.target.value)}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
        </div>
        <div>
          <label className="text-xs text-gray-500 mb-1 block">作成理由</label>
          <input type="text" value={creationReason} onChange={(e) => setCreationReason(e.target.value)}
            placeholder="例: 短期目標更新の為 / 入浴介助追加 / 掃除手順変更"
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className="text-xs text-gray-500 mb-1 block">サービス提供責任者</label>
          <input type="text" value={authorName} onChange={(e) => setAuthorName(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
        </div>
      </div>
      <div className="flex justify-between items-center gap-2 flex-wrap">
        <button onClick={() => setShowDup(true)} disabled={creating}
          className="inline-flex items-center gap-2 rounded-lg border border-blue-300 bg-white px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50">
          <Copy size={16} />
          他の利用者から複製
        </button>
        <button onClick={handleCreate} disabled={creating}
          className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50">
          {creating ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          作成して編集へ
        </button>
      </div>

      {/* 他利用者から複製モーダル */}
      {showDup && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => !dupLoading && setShowDup(false)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-gray-900 flex items-center gap-2">
                <Copy size={18} className="text-blue-600" />
                他の利用者から複製
              </h3>
              <button onClick={() => setShowDup(false)} disabled={dupLoading}
                className="text-gray-400 hover:text-gray-600 disabled:opacity-50">
                <X size={20} />
              </button>
            </div>
            <p className="text-xs text-gray-500">
              既存利用者の手順書 (= サービス・週次表・手順 全部) を「{clientName || "新規利用者"}」にコピーして編集画面に進みます。
              計画期間 / 作成理由 / 責任者 は上のフォームの値が使われます。
            </p>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">複製元 利用者</label>
              <select value={selectedSrcClient} onChange={(e) => setSelectedSrcClient(e.target.value)}
                disabled={dupLoading}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm bg-white">
                <option value="">利用者を選択</option>
                {clientList.map((c) => (
                  <option key={c.client_name} value={c.client_name}>
                    {c.client_name} ({c.version_count} 版)
                  </option>
                ))}
              </select>
            </div>
            {selectedSrcClient && (
              <div>
                <label className="text-xs text-gray-500 mb-1 block">複製元 バージョン</label>
                <select value={selectedSrcDocId} onChange={(e) => setSelectedSrcDocId(e.target.value)}
                  disabled={dupLoading || versionList.length === 0}
                  className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm bg-white">
                  {versionList.length === 0 && <option value="">読み込み中…</option>}
                  {versionList.map((v, i) => (
                    <option key={v.id} value={v.id}>
                      {i === 0 ? "[最新] " : ""}{v.plan_start_date}{v.creation_reason ? ` — ${v.creation_reason}` : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setShowDup(false)} disabled={dupLoading}
                className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded">
                キャンセル
              </button>
              <button onClick={handleDuplicate} disabled={dupLoading || !selectedSrcDocId}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50">
                {dupLoading ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />}
                複製して編集へ
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
