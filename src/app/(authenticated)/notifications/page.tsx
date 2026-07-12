"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, CalendarClock, Check, ChevronRight, FileText, Loader2 } from "lucide-react";
import { format, parseISO } from "date-fns";
import { ja } from "date-fns/locale";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import {
  isCertAlertNotification,
  resolveCertClientId,
} from "@/lib/cert-expiry-alert";
import {
  getNotifications,
  markRead,
  type NotificationRow,
} from "@/lib/notifications";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return format(parseISO(iso), "yyyy/MM/dd HH:mm", { locale: ja });
  } catch {
    return iso;
  }
}

function isDocumentRow(n: NotificationRow): boolean {
  return n.type === "document_received" && n.ref_table === "shared_documents" && !!n.ref_id;
}

function isCertRow(n: NotificationRow): boolean {
  return isCertAlertNotification(n);
}

export default function NotificationsPage() {
  const router = useRouter();
  const { currentOfficeId } = useBusinessType();
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [marking, setMarking] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!currentOfficeId) {
        if (!cancelled) {
          setRows([]);
          setLoading(false);
        }
        return;
      }
      const data = await getNotifications(currentOfficeId);
      if (cancelled) return;
      setRows(data);
      setLoading(false);
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [currentOfficeId]);

  const { unread, read } = useMemo(() => {
    const u: NotificationRow[] = [];
    const r: NotificationRow[] = [];
    for (const row of rows) {
      if (row.read_at) r.push(row);
      else u.push(row);
    }
    return { unread: u, read: r };
  }, [rows]);

  const handleMarkRead = async (id: string) => {
    setMarking(id);
    await markRead(id);
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, read_at: new Date().toISOString() } : r)),
    );
    setMarking(null);
  };

  const handleClickRow = async (row: NotificationRow) => {
    const officeQs = currentOfficeId ? `?office=${encodeURIComponent(currentOfficeId)}` : "";
    if (isDocumentRow(row)) {
      router.push(`/notifications/document/${row.ref_id}${officeQs}`);
      return;
    }
    if (isCertRow(row)) {
      // 認定更新アラート → 利用者の介護認定タブへ (ref_id = client_insurance_records.id)
      const clientId = await resolveCertClientId(createClient(), row.ref_id!);
      if (!clientId) {
        console.error("認定更新通知の参照先が見つかりません:", row.ref_id);
        return;
      }
      if (!row.read_at) {
        await markRead(row.id);
        setRows((prev) =>
          prev.map((r) =>
            r.id === row.id ? { ...r, read_at: new Date().toISOString() } : r,
          ),
        );
      }
      router.push(`/users/${clientId}/care-cert${officeQs}`);
    }
  };

  if (!currentOfficeId) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-500">
        事業所を選択してください
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center gap-2">
        <Bell size={20} />
        <h1 className="text-xl font-bold">通知</h1>
        {loading && <Loader2 size={16} className="animate-spin text-gray-400" />}
      </div>

      <Section title={`未読 (${unread.length})`} emphasis>
        {unread.length === 0 ? (
          <Empty>未読の通知はありません</Empty>
        ) : (
          <ul className="divide-y rounded-md border bg-white">
            {unread.map((row) => (
              <Row
                key={row.id}
                row={row}
                marking={marking === row.id}
                onClick={() => handleClickRow(row)}
                onMarkRead={() => handleMarkRead(row.id)}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title={`既読 (${read.length})`}>
        {read.length === 0 ? (
          <Empty>既読の通知はありません</Empty>
        ) : (
          <ul className="divide-y rounded-md border bg-white">
            {read.map((row) => (
              <Row
                key={row.id}
                row={row}
                marking={false}
                onClick={() => handleClickRow(row)}
              />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Section({
  title,
  emphasis,
  children,
}: {
  title: string;
  emphasis?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2
        className={cn(
          "text-sm font-semibold",
          emphasis ? "text-red-700" : "text-gray-600",
        )}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
      {children}
    </div>
  );
}

function Row({
  row,
  marking,
  onClick,
  onMarkRead,
}: {
  row: NotificationRow;
  marking: boolean;
  onClick: () => void;
  onMarkRead?: () => void;
}) {
  const isDoc = isDocumentRow(row);
  const isCert = isCertRow(row);
  const clickable = isDoc || isCert;
  return (
    <li
      className={cn(
        "flex items-start gap-3 px-4 py-3",
        clickable && "cursor-pointer hover:bg-blue-50",
      )}
      onClick={clickable ? onClick : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={(e) => {
        if (clickable && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className={cn("mt-0.5", isCert ? "text-amber-500" : "text-gray-400")}>
        {isDoc ? <FileText size={18} /> : isCert ? <CalendarClock size={18} /> : <Bell size={18} />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-900 truncate">{row.title}</div>
        {row.body && (
          <div className="mt-0.5 text-xs text-gray-600 line-clamp-2">{row.body}</div>
        )}
        <div className="mt-1 text-[11px] text-gray-400">
          {formatDate(row.created_at)}
          {row.read_at && (
            <span className="ml-2 text-gray-400">既読 {formatDate(row.read_at)}</span>
          )}
        </div>
      </div>
      {(isDoc || isCert) && (
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 rounded-md border border-blue-300 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100"
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
        >
          {isDoc ? "内容を見る" : "利用者を開く"}
          <ChevronRight size={12} />
        </button>
      )}
      {!row.read_at && onMarkRead && (
        <button
          type="button"
          disabled={marking}
          className="flex shrink-0 items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          onClick={(e) => {
            e.stopPropagation();
            onMarkRead();
          }}
        >
          {marking ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Check size={12} />
          )}
          既読
        </button>
      )}
    </li>
  );
}
