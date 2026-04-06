"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Users,
  CalendarDays,
  ClipboardList,
  FileText,
  LayoutDashboard,
  ClipboardCheck,
  BookOpen,
  Calculator,
  FileSpreadsheet,
  Settings,
  Activity,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import pkg from "../../../package.json";

const APP_VERSION = pkg.version;

const navigation = [
  { name: "ダッシュボード", href: "/dashboard", icon: LayoutDashboard },
  { name: "利用者管理", href: "/users", icon: Users },
  { name: "アセスメント", href: "/assessments", icon: ClipboardCheck },
  { name: "サービス管理", href: "/services", icon: ClipboardList },
  { name: "提供票", href: "/provision-sheets", icon: CalendarDays },
  { name: "モニタリング", href: "/monitoring", icon: Activity },
  { name: "支援経過記録", href: "/support-records", icon: BookOpen },
  { name: "給付管理", href: "/billing/benefits", icon: Calculator },
  { name: "レセプト", href: "/billing/claims", icon: FileSpreadsheet },
  { name: "帳票作成", href: "/reports", icon: FileText },
  { name: "マスタ管理", href: "/master", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        "flex flex-col border-r bg-white transition-all duration-200",
        collapsed ? "w-16" : "w-60"
      )}
    >
      <div className="flex h-14 items-center border-b px-4">
        {!collapsed && (
          <h1 className="text-lg font-bold text-blue-700">介護管理システム</h1>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className={cn(
            "rounded p-1 hover:bg-gray-100",
            collapsed ? "mx-auto" : "ml-auto"
          )}
        >
          {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
        </button>
      </div>
      <nav className="flex-1 space-y-1 p-2">
        {navigation.map((item) => {
          const isActive =
            item.href === "/dashboard"
              ? pathname === "/dashboard"
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-blue-50 text-blue-700"
                  : "text-gray-700 hover:bg-gray-50 hover:text-gray-900"
              )}
              title={collapsed ? item.name : undefined}
            >
              <item.icon size={20} />
              {!collapsed && <span>{item.name}</span>}
            </Link>
          );
        })}
      </nav>
      <div className="border-t px-3 py-2">
        {!collapsed && (
          <div className="text-[10px] text-gray-400 leading-relaxed">
            <div>介護管理システム v{APP_VERSION}</div>
            <div>ケアマネ版</div>
          </div>
        )}
        {collapsed && (
          <div className="text-[9px] text-gray-400 text-center">v{APP_VERSION}</div>
        )}
      </div>
    </aside>
  );
}
