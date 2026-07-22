"use client";

/**
 * /billing-visit/seikyu — 請求 (1 画面)
 *
 * 上部で 制度 (介護 / 障害) を切替え、その下の工程タブで
 * 月次情報 / 請求 / 利用請求 / 国保請求 を切替える 2 段構成。
 *   - 介護: 月次情報 / 介護請求 / 利用請求 / 国保請求
 *   - 障害: 月次情報 / 障害請求 (明細・請求書・伝送・入金を 1 画面に集約)
 * 見た目は order-app の BillingTab (ピル型サブタブ + 各タブ内に
 * カナ索引サイドバー + グレーツールバー + 格子テーブル) を踏襲。
 * SeikyuProvider で月 state / 集計結果 (介護・障害とも) / カナフィルタを
 * 全タブ横断で共有し、fetch は 1 回。
 * 訪問入浴事業所は 制度トグル = 介護保険 / 地域生活支援 (千葉市直接請求)。
 * 地域生活支援側は idou-billing の画面をそのまま埋め込む (1 画面 2 制度)。
 */

import { useState } from "react";
import { useBusinessType } from "@/lib/business-type-context";
import { SeikyuProvider } from "../_shared/seikyu-context";
import { MonthlyInfoContent } from "../_shared/monthly-info-content";
import { ShogaiMonthlyInfoContent } from "../_shared/shogai-monthly-info-content";
import { KaigoSeikyuContent } from "../kaigo-seikyu/kaigo-seikyu-content";
import { RiyouSeikyuContent } from "../riyou-seikyu/riyou-seikyu-content";
import { KokuhoSeikyuContent } from "../kokuho-seikyu/kokuho-seikyu-content";
import {
  ShogaiSeikyuContent,
  type ShogaiSeikyuView,
} from "../shogai-seikyu/shogai-seikyu-content";
import { IdouBillingContent } from "../../idou-billing/idou-billing-content";

type Seido = "kaigo" | "shogai" | "chiiki";
type SeikyuTab =
  | "monthly"
  | "kaigo"
  | "riyou"
  | "kokuho"
  | "shogai-monthly"
  | "shogai"
  | "shogai-riyou"
  | "shogai-kokuho"
  | "chiiki";

// 制度ごとの工程タブ定義
const KAIGO_TABS: { id: SeikyuTab; label: string }[] = [
  { id: "monthly", label: "月次情報" },
  { id: "kaigo", label: "介護請求" },
  { id: "riyou", label: "利用請求" },
  { id: "kokuho", label: "国保請求" },
];
const SHOGAI_TABS: { id: SeikyuTab; label: string }[] = [
  { id: "shogai-monthly", label: "月次情報" },
  { id: "shogai", label: "障害請求" },
  { id: "shogai-riyou", label: "利用請求" },
  { id: "shogai-kokuho", label: "国保請求" },
];
// 地域生活支援 (千葉市直接請求) は idou-billing 1 画面に集約済みなので工程タブは 1 つ
const CHIIKI_TABS: { id: SeikyuTab; label: string }[] = [
  { id: "chiiki", label: "地域生活支援 請求" },
];

// 工程 (月次情報 / 請求 / 利用請求 / 国保請求)。制度切替時に同じ工程を維持するための軸。
type Stage = "monthly" | "seikyu" | "riyou" | "kokuho";
const STAGE_OF: Record<SeikyuTab, Stage> = {
  monthly: "monthly",
  kaigo: "seikyu",
  riyou: "riyou",
  kokuho: "kokuho",
  "shogai-monthly": "monthly",
  shogai: "seikyu",
  "shogai-riyou": "riyou",
  "shogai-kokuho": "kokuho",
  chiiki: "seikyu",
};
const KAIGO_BY_STAGE: Record<Stage, SeikyuTab> = {
  monthly: "monthly",
  seikyu: "kaigo",
  riyou: "riyou",
  kokuho: "kokuho",
};
const SHOGAI_BY_STAGE: Record<Stage, SeikyuTab> = {
  monthly: "shogai-monthly",
  seikyu: "shogai",
  riyou: "shogai-riyou",
  kokuho: "shogai-kokuho",
};

// 制度トグル — order-app のセグメント型トグルと同トーン。
// 通常: 介護 / 障害、訪問入浴: 介護保険 / 地域生活支援 (千葉市直接請求)
function SeidoToggle({
  active,
  onChange,
  items,
}: {
  active: Seido;
  onChange: (s: Seido) => void;
  items: { id: Seido; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-lg bg-gray-100 p-0.5">
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          onClick={() => onChange(it.id)}
          className={`px-4 py-1 rounded-md text-xs font-bold transition-colors ${
            active === it.id
              ? "bg-white text-indigo-600 shadow-sm"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

// タブナビ (order-app の BillingSubTabNav と同一クラス)。左端に制度トグルを載せる。
function SeikyuTabNav({
  active,
  onChange,
  tabs,
  seido,
  onSeidoChange,
  seidoItems,
  officeName,
}: {
  active: SeikyuTab;
  onChange: (id: SeikyuTab) => void;
  tabs: { id: SeikyuTab; label: string }[];
  seido: Seido;
  onSeidoChange: (s: Seido) => void;
  seidoItems: { id: Seido; label: string }[];
  officeName?: string | null;
}) {
  return (
    <div className="border-b border-gray-200 bg-white px-3 py-2 shrink-0 flex flex-col gap-2 print:hidden">
      {officeName && (
        <span
          className="truncate text-sm font-semibold text-gray-800"
          title={officeName}
        >
          {officeName}
        </span>
      )}
      <div className="flex items-center gap-2">
        <SeidoToggle active={seido} onChange={onSeidoChange} items={seidoItems} />
        <span className="mx-1 h-5 w-px bg-gray-200" />
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className={`px-3 py-1 rounded-lg text-xs font-medium ${
              active === t.id
                ? "bg-indigo-500 text-white"
                : "bg-gray-100 text-gray-500 hover:bg-gray-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SeikyuInner() {
  const { businessType, currentOffice } = useBusinessType();
  const isBath = businessType === "訪問入浴";
  const [seido, setSeido] = useState<Seido>("kaigo");
  const [tab, setTab] = useState<SeikyuTab>("monthly");

  // 訪問入浴は 介護保険 / 地域生活支援、それ以外は 介護 / 障害 (相互に無効な値は介護へ丸める)
  const effectiveSeido: Seido = isBath
    ? seido === "shogai" ? "kaigo" : seido
    : seido === "chiiki" ? "kaigo" : seido;
  const seidoItems: { id: Seido; label: string }[] = isBath
    ? [
        { id: "kaigo", label: "介護保険" },
        { id: "chiiki", label: "地域生活支援" },
      ]
    : [
        { id: "kaigo", label: "介護" },
        { id: "shogai", label: "障害" },
      ];
  const tabs =
    effectiveSeido === "shogai" ? SHOGAI_TABS : effectiveSeido === "chiiki" ? CHIIKI_TABS : KAIGO_TABS;

  // 制度切替時は現在の工程を維持する (介護請求↔障害請求、利用請求↔利用請求 …)。
  // 例: 介護の利用請求を見ていて障害に切替 → 障害の利用請求へ (月次情報に戻さない)。
  // 地域生活支援は 1 画面なので常に chiiki タブへ。
  const handleSeidoChange = (s: Seido) => {
    setSeido(s);
    const stage = STAGE_OF[tab];
    setTab(s === "shogai" ? SHOGAI_BY_STAGE[stage] : s === "chiiki" ? "chiiki" : KAIGO_BY_STAGE[stage]);
  };

  // 障害の 請求 / 利用請求 / 国保請求 は同一 ShogaiSeikyuContent を view 出し分け。
  // 3 タブで同じ要素を保つと React が再マウントせず、月切替のみで再集計 (fetch 1 回)。
  const shogaiView: ShogaiSeikyuView =
    tab === "shogai-riyou" ? "riyou" : tab === "shogai-kokuho" ? "kokuho" : "seikyu";
  const showShogaiSeikyu =
    tab === "shogai" || tab === "shogai-riyou" || tab === "shogai-kokuho";

  return (
    // layout の main (p-6) を打ち消して order-app と同じ全面白ベースにする。
    // 高さは main の可視領域いっぱい (padding 3rem ぶんを足し戻す)。
    // 印刷時は高さ固定と flex を解除して印刷 view の流し込みを崩さない。
    <div className="-m-6 flex h-[calc(100%+3rem)] flex-col bg-white text-sm print:m-0 print:block print:h-auto">
      <SeikyuTabNav
        active={tab}
        onChange={setTab}
        tabs={tabs}
        seido={effectiveSeido}
        onSeidoChange={handleSeidoChange}
        seidoItems={seidoItems}
        officeName={currentOffice?.name}
      />
      {tab === "monthly" && <MonthlyInfoContent />}
      {tab === "kaigo" && <KaigoSeikyuContent />}
      {tab === "riyou" && <RiyouSeikyuContent />}
      {tab === "kokuho" && <KokuhoSeikyuContent />}
      {tab === "shogai-monthly" && !isBath && <ShogaiMonthlyInfoContent />}
      {showShogaiSeikyu && !isBath && <ShogaiSeikyuContent view={shogaiView} />}
      {tab === "chiiki" && isBath && (
        <div className="flex-1 overflow-y-auto print:overflow-visible">
          <IdouBillingContent />
        </div>
      )}
    </div>
  );
}

export function SeikyuContent() {
  return (
    <SeikyuProvider>
      <SeikyuInner />
    </SeikyuProvider>
  );
}
