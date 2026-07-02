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
  ChevronLeft,
  ChevronRight,
  NotebookPen,
  MessagesSquare,
  AlertTriangle,
  Bell,
  Accessibility,
  Loader2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useBusinessType } from "@/lib/business-type-context";
import { useLocalStorage } from "@/lib/use-local-storage";
import { getUnreadCount } from "@/lib/notifications";
import pkg from "../../../package.json";
import { SidebarLegacy } from "./sidebar-legacy";

const APP_VERSION = pkg.version;

type NavItem = { name: string; href: string; icon: React.ComponentType<{ size?: number }> };
type SectionSpec = { title?: string; items: NavItem[] };

// ── ケアマネ版 (居宅介護支援) — セクション分割
const NAV_CARE_MANAGER_SECTIONED: SectionSpec[] = [
  {
    items: [
      { name: "ダッシュボード", href: "/dashboard", icon: LayoutDashboard },
      { name: "通知", href: "/notifications", icon: Bell },
      { name: "利用者管理", href: "/users", icon: Users },
    ],
  },
  {
    title: "日常業務",
    items: [
      { name: "アセスメント", href: "/assessments", icon: ClipboardCheck },
      { name: "居宅サービス計画書", href: "/reports/care-plan-1", icon: ClipboardList },
      { name: "担当者会議録", href: "/meeting-minutes", icon: MessagesSquare },
      { name: "利用票・提供票", href: "/reports/service-usage", icon: CalendarDays },
      { name: "利用票別表", href: "/reports/service-usage-detail", icon: FileSpreadsheet },
      { name: "モニタリング", href: "/monitoring", icon: Activity },
      { name: "支援経過", href: "/support-records", icon: NotebookPen },
      { name: "入退院管理", href: "/hospitalizations", icon: CalendarDays },
      { name: "緊急時シート", href: "/emergency-sheets", icon: AlertTriangle },
      { name: "重要事項・契約書", href: "/user-contracts", icon: FileText },
    ],
  },
  {
    title: "請求業務",
    items: [
      { name: "給付管理", href: "/billing/benefits", icon: Calculator },
      { name: "加算管理", href: "/addons", icon: Calculator },
      { name: "レセプト", href: "/billing/claims", icon: FileSpreadsheet },
      { name: "明細書・請求書", href: "/billing/forms", icon: FileText },
    ],
  },
  {
    title: "障害福祉",
    items: [
      { name: "サービス提供実績", href: "/shogai/records", icon: ClipboardCheck },
      { name: "障害請求", href: "/billing-visit/shogai-seikyu", icon: Calculator },
      // 受給者証・障害支援区分 は 利用者管理 → 障害福祉タブ (/users/[id]/disability, /shougai-cert) に集約
    ],
  },
  {
    title: "管理",
    items: [
      { name: "職員管理", href: "/staff", icon: UserCog },
      { name: "マスタ管理", href: "/master", icon: Settings },
      { name: "設定", href: "/settings", icon: UserCog },
    ],
  },
];

// ── 訪問介護版 — セクション分割
const NAV_HOME_CARE_SECTIONED: SectionSpec[] = [
  {
    items: [
      { name: "ダッシュボード", href: "/dashboard", icon: LayoutDashboard },
      { name: "通知", href: "/notifications", icon: Bell },
      { name: "利用者管理", href: "/users", icon: Users },
    ],
  },
  {
    title: "日常業務",
    items: [
      { name: "ケアプラン取込", href: "/careplan-import", icon: FileText },
      { name: "利用状況・シフト管理", href: "/shift-management", icon: CalendarDays },
      { name: "パターン登録", href: "/shift-management/patterns", icon: Clock },
      { name: "サービス提供表 (実績)", href: "/provision-tickets", icon: FileSpreadsheet },
      { name: "サービス実施記録", href: "/visit-records", icon: ClipboardCheck },
      { name: "訪問介護計画書", href: "/houmon-care-plans", icon: ClipboardList },
      { name: "手順書", href: "/visit-procedures", icon: BookOpen },
      { name: "重要事項・契約書", href: "/user-contracts", icon: FileText },
    ],
  },
  {
    title: "請求業務",
    items: [
      { name: "サービス提供表 (実績)", href: "/provision-tickets", icon: FileSpreadsheet },
      { name: "介護請求", href: "/billing-visit/kaigo-seikyu", icon: Calculator },
      { name: "利用請求", href: "/billing-visit/riyou-seikyu", icon: Calculator },
      { name: "国保請求", href: "/billing-visit/kokuho-seikyu", icon: FileSpreadsheet },
      { name: "加算管理", href: "/addons", icon: Calculator },
      { name: "実績管理", href: "/visit-billing", icon: Calculator },
      { name: "帳票作成", href: "/reports-visit", icon: FileText },
    ],
  },
  {
    title: "障害福祉",
    items: [
      { name: "サービス提供実績", href: "/shogai/records", icon: ClipboardCheck },
      { name: "障害請求", href: "/billing-visit/shogai-seikyu", icon: Calculator },
      // 受給者証・障害支援区分 は 利用者管理 → 障害福祉タブ (/users/[id]/disability, /shougai-cert) に集約
    ],
  },
  {
    title: "管理",
    items: [
      { name: "職員管理", href: "/staff", icon: UserCog },
      { name: "マスタ管理", href: "/master", icon: Settings },
      { name: "設定", href: "/settings", icon: UserCog },
    ],
  },
];

const BUSINESS_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  "居宅介護支援": { label: "ケアマネ版", color: "text-blue-600" },
  "訪問介護": { label: "訪問介護版", color: "text-green-600" },
  "通所介護": { label: "通所介護版", color: "text-orange-600" },
};

export function Sidebar() {
  // legacy layout に切替 flag (localStorage で永続化)
  const [useLegacy, setUseLegacy] = useLocalStorage(
    "sidebar-legacy",
    false,
    (raw) => raw === "true",
  );
  if (useLegacy) {
    return <SidebarLegacy onSwitchLayout={() => setUseLegacy(false)} />;
  }
  return <SidebarV2 onSwitchLayout={() => setUseLegacy(true)} />;
}

function SidebarV2({ onSwitchLayout }: { onSwitchLayout: () => void }) {
  const pathname = usePathname();
  const { businessType, currentOffice } = useBusinessType();
  const [collapsed, setCollapsed] = useLocalStorage(
    "sidebar-collapsed",
    false,
    (raw) => raw === "true",
  );
  const toggleCollapsed = () => setCollapsed(!collapsed);

  const sections: SectionSpec[] =
    businessType === "訪問介護"
      ? NAV_HOME_CARE_SECTIONED
      : NAV_CARE_MANAGER_SECTIONED;
  const typeInfo = BUSINESS_TYPE_LABELS[businessType] ?? BUSINESS_TYPE_LABELS["居宅介護支援"];

  // 通知未読 badge (1 分間隔で polling)
  const [unread, setUnread] = useState(0);
  const officeIdForUnread = currentOffice?.id;
  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      if (!officeIdForUnread) {
        if (!cancelled) setUnread(0);
        return;
      }
      const n = await getUnreadCount(officeIdForUnread);
      if (!cancelled) setUnread(n);
    };
    fetchOnce();
    if (!officeIdForUnread) return () => { cancelled = true; };
    const id = setInterval(fetchOnce, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [officeIdForUnread]);

  const appendMode = (href: string) => {
    if (!currentOffice) return href;
    return `${href}?office=${encodeURIComponent(currentOffice.id)}`;
  };

  // optimistic active: クリック瞬間にハイライトを切替 (遷移完了を待たない)
  // pathname が変わったら reset
  const [clickedHref, setClickedHref] = useState<string | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 遷移完了で optimistic 状態を解除
    setClickedHref(null);
  }, [pathname]);

  const renderItem = (item: NavItem) => {
    const isActive = clickedHref
      ? clickedHref === item.href
      : item.href === "/dashboard"
        ? pathname === "/dashboard"
        : pathname.startsWith(item.href);
    const isNotifications = item.href === "/notifications";
    const showBadge = isNotifications && unread > 0;
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={appendMode(item.href)}
        // dynamic ページも full page を事前取得 (staleTimes.static=300s が適用され
        // メニュー往復が 5 分間ほぼゼロ往復になる)。利用者は単独運用のため
        // prefetch 増によるサーバー負荷は問題にならない。
        prefetch={true}
        onClick={() => setClickedHref(item.href)}
        title={collapsed ? item.name : undefined}
        className={cn(
          "relative flex items-center rounded-md transition-colors",
          collapsed ? "justify-center py-2" : "gap-3 px-3 py-2",
          isActive
            ? "bg-blue-50 text-blue-700"
            : "text-gray-700 hover:bg-gray-50 hover:text-gray-900",
        )}
      >
        {/* icon 列を 20px 固定幅で揃える (視線が縦にスムーズに流れる) */}
        <span className="flex w-5 shrink-0 items-center justify-center">
          <Icon size={18} />
        </span>
        {!collapsed && (
          <>
            <span className="flex-1 truncate text-[13px] font-medium">
              {item.name}
            </span>
            {clickedHref === item.href && (
              <Loader2 size={12} className="ml-auto animate-spin text-blue-500" />
            )}
            {showBadge && (
              <span className="ml-auto min-w-[20px] rounded-full bg-red-500 px-1.5 text-center text-[11px] font-semibold leading-[18px] text-white">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </>
        )}
        {collapsed && showBadge && (
          <span className="absolute right-1 top-1 min-w-[16px] rounded-full bg-red-500 px-1 text-center text-[9px] font-semibold leading-[14px] text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </Link>
    );
  };

  return (
    <aside
      className={cn(
        "flex flex-col border-r bg-white transition-all duration-200",
        collapsed ? "w-16" : "w-60",
      )}
    >
      <div className="flex h-14 items-center border-b px-4">
        {!collapsed && (
          <h1 className="text-lg font-bold text-blue-700">介護管理システム</h1>
        )}
        <button
          onClick={toggleCollapsed}
          className={cn(
            "rounded p-1 hover:bg-gray-100",
            collapsed ? "mx-auto" : "ml-auto",
          )}
        >
          {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
        </button>
      </div>

      <nav className="flex-1 space-y-3 overflow-y-auto p-2">
        {sections.map((sec, i) => (
          <div key={sec.title ?? `sec-${i}`} className="space-y-0.5">
            {/* section 見出し */}
            {sec.title && !collapsed && (
              <div className="mt-2 flex items-center gap-2 px-3 pb-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                  {sec.title}
                </span>
                <span className="h-px flex-1 bg-gray-100" />
              </div>
            )}
            {sec.title && collapsed && (
              // 折畳時は section 見出しの代わりに thin divider
              i > 0 && <div className="my-1 h-px bg-gray-200" />
            )}
            {sec.items.map(renderItem)}
          </div>
        ))}
      </nav>

      <div className="border-t px-3 py-2">
        {!collapsed && (
          <div className="text-[10px] leading-relaxed text-gray-400">
            <div>介護管理システム v{APP_VERSION}</div>
            <div className={typeInfo.color}>{typeInfo.label}</div>
            {currentOffice && (
              <div
                className="mt-1 truncate border-t border-gray-100 pt-1 text-gray-600"
                title={currentOffice.name}
              >
                🏢 {currentOffice.name || "(名称未設定)"}
              </div>
            )}
            <button
              type="button"
              onClick={onSwitchLayout}
              className="mt-2 w-full rounded border border-gray-200 bg-gray-50 px-2 py-1 text-[10px] text-gray-600 hover:bg-gray-100"
            >
              旧レイアウトに戻す
            </button>
          </div>
        )}
        {collapsed && (
          <div className="text-center text-[9px] text-gray-400">v{APP_VERSION}</div>
        )}
      </div>
    </aside>
  );
}
