"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBusinessType } from "@/lib/business-type-context";
import { getUnreadCount } from "@/lib/notifications";

const POLL_INTERVAL_MS = 60_000; // 1 分

/**
 * Header 用未読通知 badge。
 * - 現在選択中の office (currentOfficeId) の未読 notifications 件数を表示
 * - 1 分間隔で polling
 * - クリックで /notifications に遷移
 */
export function NotificationBadge() {
  const { currentOfficeId } = useBusinessType();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      if (!currentOfficeId) {
        if (!cancelled) setUnread(0);
        return;
      }
      const n = await getUnreadCount(currentOfficeId);
      if (!cancelled) setUnread(n);
    };
    fetchOnce();
    if (!currentOfficeId) {
      return () => {
        cancelled = true;
      };
    }
    const id = setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [currentOfficeId]);

  const href = currentOfficeId
    ? `/notifications?office=${encodeURIComponent(currentOfficeId)}`
    : "/notifications";

  return (
    <Link
      href={href}
      className={cn(
        "relative flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-gray-600 hover:bg-gray-100",
      )}
      title="通知一覧"
      aria-label={unread > 0 ? `通知 ${unread} 件 未読` : "通知"}
    >
      <Bell size={18} />
      {unread > 0 && (
        <span
          className={cn(
            "absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full bg-red-500 px-1 text-center text-[10px] font-semibold leading-[18px] text-white",
          )}
        >
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}
