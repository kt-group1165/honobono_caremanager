"use client";

import { Building2, LogOut, User } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { NotificationBadge } from "@/components/layout/notification-badge";
import { useBusinessType } from "@/lib/business-type-context";

export function Header() {
  const router = useRouter();
  const supabase = createClient();
  const { currentOffice } = useBusinessType();

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  return (
    <header className="flex h-10 items-center justify-between border-b bg-white px-6 print:hidden">
      <div className="flex items-center gap-2 text-sm font-semibold text-gray-800 min-w-0">
        {currentOffice?.name && (
          <>
            <Building2 size={16} className="shrink-0 text-gray-400" />
            <span className="truncate" title={currentOffice.name}>
              {currentOffice.name}
            </span>
          </>
        )}
      </div>
      <div className="flex items-center gap-4">
        <NotificationBadge />
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <User size={16} />
          <span>管理者</span>
        </div>
        <button
          onClick={handleLogout}
          className="flex items-center gap-1 rounded-md px-3 py-1 text-sm text-gray-600 hover:bg-gray-100"
        >
          <LogOut size={16} />
          <span>ログアウト</span>
        </button>
      </div>
    </header>
  );
}
