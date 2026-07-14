"use client";

// 事業所マスタ 統合タブシェル
// - 自社グループ / 他社:居宅・ケアマネ / 他社:サービス提供 を 1 画面に束ねる
// - 各タブの中身は既存の content コンポーネントをそのまま再利用 (テーブル無変更)
// - タブは URL クエリ ?tab= に同期 (ブックマーク・直リンク可)。旧 URL からの
//   リダイレクトもこの ?tab= に着地する
// - display 切替 (hidden) で全タブ常時マウント → 検索文字や編集中 state が
//   タブ往復で消えない (対象データは各百件規模で軽い)

import { useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Building, Home, Building2 } from "lucide-react";
import { OfficeContent, type OfficeSettings } from "../office/office-content";
import { CareOfficesContent, type CareOffice } from "../care-offices/care-offices-content";
import { ProvidersContent, type ServiceProvider } from "../providers/providers-content";

export type OfficesTab = "group" | "care" | "provider";

const TABS: { key: OfficesTab; label: string; sub: string; icon: typeof Building; color: string }[] = [
  { key: "group", label: "自社グループ事業所", sub: "自社の登録・加算設定", icon: Building, color: "indigo" },
  { key: "care", label: "他社：居宅・ケアマネ", sub: "担当居宅介護支援事業所", icon: Home, color: "rose" },
  { key: "provider", label: "他社：サービス提供事業所", sub: "ケアプランの提供事業所", icon: Building2, color: "green" },
];

export function OfficesMasterTabs({
  initialTab,
  groupOffices,
  careOffices,
  providers,
}: {
  initialTab: OfficesTab;
  groupOffices: OfficeSettings[];
  careOffices: CareOffice[];
  providers: ServiceProvider[];
}) {
  const [tab, setTab] = useState<OfficesTab>(initialTab);
  const router = useRouter();
  const pathname = usePathname();

  const select = (key: OfficesTab) => {
    setTab(key);
    // URL 同期 (scroll 維持、履歴を汚さないよう replace)
    router.replace(`${pathname}?tab=${key}`, { scroll: false });
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">事業所マスタ</h1>
        <p className="mt-1 text-sm text-gray-500">
          自社グループ・他社の事業所を種別ごとに管理します
        </p>
      </div>

      {/* タブ */}
      <div className="flex flex-wrap gap-2 border-b">
        {TABS.map((t) => {
          const active = tab === t.key;
          const count =
            t.key === "group" ? groupOffices.length : t.key === "care" ? careOffices.length : providers.length;
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => select(t.key)}
              className={`-mb-px flex items-center gap-2 rounded-t-lg border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? "border-blue-600 text-blue-700"
                  : "border-transparent text-gray-500 hover:text-gray-800"
              }`}
            >
              <Icon size={16} className={active ? "text-blue-600" : "text-gray-400"} />
              <span>{t.label}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs ${
                  active ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-500"
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* 中身 (全タブ常時マウント、hidden で表示切替) */}
      <div hidden={tab !== "group"}>
        <OfficeContent initialOffices={groupOffices} />
      </div>
      <div hidden={tab !== "care"}>
        <CareOfficesContent initialOffices={careOffices} />
      </div>
      <div hidden={tab !== "provider"}>
        <ProvidersContent initialProviders={providers} />
      </div>
    </div>
  );
}
