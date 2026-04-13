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
  UserCog,
  Clock,
  Home,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Briefcase,
  NotebookPen,
  MessagesSquare,
} from "lucide-react";
import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { useBusinessType } from "@/lib/business-type-context";
import pkg from "../../../package.json";

const APP_VERSION = pkg.version;

type NavItem = { name: string; href: string; icon: React.ComponentType<{ size?: number }> };
type NavGroup = { name: string; icon: React.ComponentType<{ size?: number }>; children: NavItem[] };
type NavEntry = NavItem | NavGroup;

function isGroup(entry: NavEntry): entry is NavGroup {
  return "children" in entry;
}

// ケアマネ版メニュー
const NAV_CARE_MANAGER: NavEntry[] = [
  { name: "ダッシュボード", href: "/dashboard", icon: LayoutDashboard },
  { name: "利用者管理", href: "/users", icon: Users },
  {
    name: "ケアマネ業務",
    icon: Briefcase,
    children: [
      { name: "アセスメント", href: "/assessments", icon: ClipboardCheck },
      { name: "計画書", href: "/reports/care-plan-1", icon: ClipboardList },
      { name: "会議録", href: "/meeting-minutes", icon: MessagesSquare },
      { name: "利用・提供票", href: "/reports/service-usage", icon: CalendarDays },
      { name: "利用票別表", href: "/reports/service-usage-detail", icon: FileSpreadsheet },
      { name: "モニタリング", href: "/monitoring", icon: Activity },
      { name: "支援経過", href: "/support-records", icon: NotebookPen },
    ],
  },
  { name: "給付管理", href: "/billing/benefits", icon: Calculator },
  { name: "レセプト", href: "/billing/claims", icon: FileSpreadsheet },
  { name: "明細書・請求書", href: "/billing/forms", icon: FileText },
  // 帳票作成: 全帳票がケアマネ業務メニューに移動したため非表示
  { name: "マスタ管理", href: "/master", icon: Settings },
  { name: "設定", href: "/settings", icon: UserCog },
];

// 訪問介護版メニュー
const NAV_HOME_CARE: NavEntry[] = [
  { name: "ダッシュボード", href: "/dashboard", icon: LayoutDashboard },
  { name: "利用者管理", href: "/users", icon: Users },
  { name: "職員管理", href: "/staff", icon: UserCog },
  { name: "ケアプラン取込", href: "/careplan-import", icon: FileText },
  { name: "シフト管理", href: "/shift-management", icon: CalendarDays },
  { name: "パターン登録", href: "/shift-management/patterns", icon: Clock },
  { name: "サービス提供表（実績）", href: "/provision-tickets", icon: FileSpreadsheet },
  { name: "サービス実施記録", href: "/visit-records", icon: ClipboardCheck },
  { name: "実績管理", href: "/visit-billing", icon: Calculator },
  { name: "帳票作成", href: "/reports-visit", icon: FileText },
  { name: "マスタ管理", href: "/master", icon: Settings },
  { name: "設定", href: "/settings", icon: UserCog },
];

const BUSINESS_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  "居宅介護支援": { label: "ケアマネ版", color: "text-blue-600" },
  "訪問介護": { label: "訪問介護版", color: "text-green-600" },
  "通所介護": { label: "通所介護版", color: "text-orange-600" },
};

export function Sidebar() {
  const pathname = usePathname();
  const { businessType } = useBusinessType();
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("sidebar-collapsed") === "true";
    }
    return false;
  });
  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem("sidebar-collapsed", String(next));
  };

  // グループごとの開閉状態（localStorage に永続化）
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") return { "ケアマネ業務": true };
    try {
      const stored = localStorage.getItem("sidebar-open-groups");
      if (stored) return JSON.parse(stored);
    } catch { /* ignore */ }
    return { "ケアマネ業務": true };
  });
  const toggleGroup = (name: string) => {
    setOpenGroups((prev) => {
      const next = { ...prev, [name]: !prev[name] };
      if (typeof window !== "undefined") {
        localStorage.setItem("sidebar-open-groups", JSON.stringify(next));
      }
      return next;
    });
  };

  const navigation: NavEntry[] =
    businessType === "訪問介護" ? NAV_HOME_CARE : NAV_CARE_MANAGER;
  const typeInfo = BUSINESS_TYPE_LABELS[businessType] ?? BUSINESS_TYPE_LABELS["居宅介護支援"];

  // 子ページを開いていたら親グループは自動で開く
  useEffect(() => {
    for (const entry of navigation) {
      if (isGroup(entry)) {
        const anyChildActive = entry.children.some((c) => pathname.startsWith(c.href));
        if (anyChildActive && !openGroups[entry.name]) {
          setOpenGroups((prev) => ({ ...prev, [entry.name]: true }));
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, businessType]);

  return (
    <aside
      className={cn(
        "flex flex-col border-r bg-white transition-all duration-200",
        collapsed ? "w-16" : "w-60"
      )}
    >
      <div className="flex h-14 items-center border-b px-4">
        {!collapsed && (
          <div>
            <h1 className="text-lg font-bold text-blue-700">介護管理システム</h1>
          </div>
        )}
        <button
          onClick={toggleCollapsed}
          className={cn(
            "rounded p-1 hover:bg-gray-100",
            collapsed ? "mx-auto" : "ml-auto"
          )}
        >
          {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
        </button>
      </div>
      <nav className="flex-1 space-y-1 p-2 overflow-y-auto">
        {navigation.map((entry) => {
          // グループ（子メニュー付き）
          if (isGroup(entry)) {
            const groupOpen = openGroups[entry.name] ?? false;
            const anyChildActive = entry.children.some((c) => pathname.startsWith(c.href));
            const GroupIcon = entry.icon;
            return (
              <div key={entry.name}>
                <button
                  onClick={() => toggleGroup(entry.name)}
                  className={cn(
                    "w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    anyChildActive
                      ? "bg-blue-50 text-blue-700"
                      : "text-gray-700 hover:bg-gray-50 hover:text-gray-900"
                  )}
                  title={collapsed ? entry.name : undefined}
                >
                  <GroupIcon size={20} />
                  {!collapsed && (
                    <>
                      <span className="flex-1 text-left">{entry.name}</span>
                      <ChevronDown
                        size={14}
                        className={cn(
                          "transition-transform",
                          groupOpen ? "rotate-0" : "-rotate-90"
                        )}
                      />
                    </>
                  )}
                </button>
                {!collapsed && groupOpen && (
                  <div className="ml-3 mt-0.5 space-y-0.5 border-l border-gray-200 pl-2">
                    {entry.children.map((child) => {
                      const isActive = pathname.startsWith(child.href);
                      const ChildIcon = child.icon;
                      return (
                        <Link
                          key={child.href}
                          href={child.href}
                          className={cn(
                            "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors",
                            isActive
                              ? "bg-blue-50 text-blue-700"
                              : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                          )}
                        >
                          <ChildIcon size={15} />
                          <span>{child.name}</span>
                        </Link>
                      );
                    })}
                  </div>
                )}
                {/* 折りたたみ時は子をアイコンで表示 */}
                {collapsed && (
                  <div className="space-y-1">
                    {entry.children.map((child) => {
                      const isActive = pathname.startsWith(child.href);
                      const ChildIcon = child.icon;
                      return (
                        <Link
                          key={child.href}
                          href={child.href}
                          className={cn(
                            "flex items-center justify-center rounded-md py-2 transition-colors",
                            isActive
                              ? "bg-blue-50 text-blue-700"
                              : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                          )}
                          title={child.name}
                        >
                          <ChildIcon size={20} />
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }

          // 単一メニュー項目
          const isActive =
            entry.href === "/dashboard"
              ? pathname === "/dashboard"
              : pathname.startsWith(entry.href);
          return (
            <Link
              key={entry.href}
              href={entry.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-blue-50 text-blue-700"
                  : "text-gray-700 hover:bg-gray-50 hover:text-gray-900"
              )}
              title={collapsed ? entry.name : undefined}
            >
              <entry.icon size={20} />
              {!collapsed && <span>{entry.name}</span>}
            </Link>
          );
        })}
      </nav>
      <div className="border-t px-3 py-2">
        {!collapsed && (
          <div className="text-[10px] text-gray-400 leading-relaxed">
            <div>介護管理システム v{APP_VERSION}</div>
            <div className={typeInfo.color}>{typeInfo.label}</div>
          </div>
        )}
        {collapsed && (
          <div className="text-[9px] text-gray-400 text-center">v{APP_VERSION}</div>
        )}
      </div>
    </aside>
  );
}
