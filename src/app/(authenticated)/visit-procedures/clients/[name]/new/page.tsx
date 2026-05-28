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
import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Save, Loader2, BookOpen } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { saveDocument } from "@/lib/visit-procedure/queries";
import { emptyDocument } from "@/lib/visit-procedure/types";

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
      <div className="flex justify-end">
        <button onClick={handleCreate} disabled={creating}
          className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50">
          {creating ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          作成して編集へ
        </button>
      </div>
    </div>
  );
}
