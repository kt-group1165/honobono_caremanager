"use client";

import { useEffect, useRef, useState, use } from "react";
import Link from "next/link";
import { ArrowLeft, Download, Loader2, Printer } from "lucide-react";
import { format, parseISO } from "date-fns";
import { ja } from "date-fns/locale";
import { toast } from "sonner";
import {
  getSharedDocument,
  markSharedDocumentRead,
  type SharedDocumentRow,
} from "@/lib/notifications";
import { useBusinessType } from "@/lib/business-type-context";
import { ImportServiceRecordModal } from "@/components/shared/ImportServiceRecordModal";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return format(parseISO(iso), "yyyy/MM/dd HH:mm", { locale: ja });
  } catch {
    return iso;
  }
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function SharedDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { currentOfficeId } = useBusinessType();
  const [doc, setDoc] = useState<SharedDocumentRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [showImport, setShowImport] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // 同一書類で複数回 read マークしないようにするフラグ。
  const markedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      const row = await getSharedDocument(id);
      if (cancelled) return;
      setDoc(row);
      setLoading(false);
      // 初回アクセス時のみ read 化 (まだ未読の場合)。
      if (row && !row.read_at && !markedRef.current) {
        markedRef.current = true;
        await markSharedDocumentRead(row.id);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const handlePrint = () => {
    const win = iframeRef.current?.contentWindow;
    if (win) {
      try {
        win.focus();
        win.print();
        return;
      } catch {
        // fallthrough → window.print
      }
    }
    window.print();
  };

  const backHref = currentOfficeId
    ? `/notifications?office=${encodeURIComponent(currentOfficeId)}`
    : "/notifications";

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-500">
        <Loader2 size={20} className="mr-2 animate-spin" />
        読み込み中...
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
        >
          <ArrowLeft size={14} /> 通知一覧へ戻る
        </Link>
        <div className="rounded-md border bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
          書類が見つかりませんでした (削除済 or 権限なし)
        </div>
      </div>
    );
  }

  const canImport = doc.document_type === "service_record_monthly";

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
        >
          <ArrowLeft size={14} /> 通知一覧へ戻る
        </Link>
        <div className="flex items-center gap-2">
          {canImport && (
            <button
              type="button"
              onClick={() => setShowImport(true)}
              className="inline-flex items-center gap-1 rounded-md border border-blue-600 bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
            >
              <Download size={14} />
              利用票・提供票に取り込む
            </button>
          )}
          <button
            type="button"
            onClick={handlePrint}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            <Printer size={14} />
            印刷
          </button>
        </div>
      </div>
      <div className="rounded-md border bg-white px-4 py-3">
        <h1 className="text-base font-semibold text-gray-900">{doc.title}</h1>
        <div className="mt-1 text-xs text-gray-500">
          受信日時: {formatDate(doc.sent_at)}
          {doc.read_at && (
            <span className="ml-3">既読: {formatDate(doc.read_at)}</span>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-hidden rounded-md border bg-white">
        <iframe
          ref={iframeRef}
          srcDoc={doc.html_content}
          // allow-same-origin: srcDoc 内 CSS / 内部 anchor 用
          // allow-popups / allow-popups-to-escape-sandbox: 印刷ダイアログ等の挙動を保証
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          className="h-[70vh] w-full border-0"
          title={doc.title}
        />
      </div>

      {showImport && (
        <ImportServiceRecordModal
          shared={doc}
          onClose={() => setShowImport(false)}
          onSuccess={(msg) => {
            toast.success(msg);
            setShowImport(false);
          }}
          onError={(msg) => {
            toast.error(msg);
          }}
        />
      )}
    </div>
  );
}
