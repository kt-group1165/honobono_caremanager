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
 * 訪問入浴事業所は障害の対象外なので制度トグルを出さず介護のみ。
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

type Seido = "kaigo" | "shogai";
type SeikyuTab =
  | "monthly"
  | "kaigo"
  | "riyou"
  | "kokuho"
  | "shogai-monthly"
  | "shogai"
  | "shogai-riyou"
  | "shogai-kokuho";

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

// 制度トグル (介護 / 障害) — order-app のセグメント型トグルと同トーン
function SeidoToggle({
  active,
  onChange,
}: {
  active: Seido;
  onChange: (s: Seido) => void;
}) {
  const items: { id: Seido; label: string }[] = [
    { id: "kaigo", label: "介護" },
    { id: "shogai", label: "障害" },
  ];
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
  showSeido,
}: {
  active: SeikyuTab;
  onChange: (id: SeikyuTab) => void;
  tabs: { id: SeikyuTab; label: string }[];
  seido: Seido;
  onSeidoChange: (s: Seido) => void;
  showSeido: boolean;
}) {
  return (
    <div className="border-b border-gray-200 bg-white px-3 py-2 shrink-0 flex items-center gap-2 print:hidden">
      {showSeido && (
        <>
          <SeidoToggle active={seido} onChange={onSeidoChange} />
          <span className="mx-1 h-5 w-px bg-gray-200" />
        </>
      )}
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
  );
}

function SeikyuInner() {
  const { businessType } = useBusinessType();
  const isBath = businessType === "訪問入浴";
  const [seido, setSeido] = useState<Seido>("kaigo");
  const [tab, setTab] = useState<SeikyuTab>("monthly");

  // 訪問入浴は障害対象外 → 常に介護、制度トグル非表示
  const effectiveSeido: Seido = isBath ? "kaigo" : seido;
  const tabs = effectiveSeido === "shogai" ? SHOGAI_TABS : KAIGO_TABS;

  // 制度切替時は工程タブを各制度の先頭 (月次情報) にリセット
  const handleSeidoChange = (s: Seido) => {
    setSeido(s);
    setTab(s === "shogai" ? "shogai-monthly" : "monthly");
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
        showSeido={!isBath}
      />
      {tab === "monthly" && <MonthlyInfoContent />}
      {tab === "kaigo" && <KaigoSeikyuContent />}
      {tab === "riyou" && <RiyouSeikyuContent />}
      {tab === "kokuho" && <KokuhoSeikyuContent />}
      {tab === "shogai-monthly" && !isBath && <ShogaiMonthlyInfoContent />}
      {showShogaiSeikyu && !isBath && <ShogaiSeikyuContent view={shogaiView} />}
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
