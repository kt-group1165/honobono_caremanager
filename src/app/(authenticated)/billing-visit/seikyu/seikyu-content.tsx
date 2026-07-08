"use client";

/**
 * /billing-visit/seikyu — 請求 (1 画面タブ切替)
 *
 * 月次情報 / 介護請求 / 利用請求 / 国保請求 を 1 画面のタブで切替える。
 * 見た目は order-app の BillingTab (ピル型サブタブ + 各タブ内に
 * カナ索引サイドバー + グレーツールバー + 格子テーブル) を踏襲。
 * SeikyuProvider で月 state / 集計結果 / カナフィルタを全タブ横断で共有し、
 * fetch は 1 回。
 */

import { useState } from "react";
import { SeikyuProvider } from "../_shared/seikyu-context";
import { MonthlyInfoContent } from "../_shared/monthly-info-content";
import { KaigoSeikyuContent } from "../kaigo-seikyu/kaigo-seikyu-content";
import { RiyouSeikyuContent } from "../riyou-seikyu/riyou-seikyu-content";
import { KokuhoSeikyuContent } from "../kokuho-seikyu/kokuho-seikyu-content";
import { ShogaiSeikyuContent } from "../shogai-seikyu/shogai-seikyu-content";

type SeikyuTab = "monthly" | "kaigo" | "riyou" | "kokuho" | "shogai";

const SEIKYU_TABS: { id: SeikyuTab; label: string }[] = [
  { id: "monthly", label: "月次情報" },
  { id: "kaigo", label: "介護請求" },
  { id: "riyou", label: "利用請求" },
  { id: "kokuho", label: "国保請求" },
  // 障害請求は独立メニューを廃し、介護請求のタブに統合 (2026-07-08)。
  // ShogaiSeikyuContent は自己完結 (独自 MonthNav / useBusinessType、SeikyuProvider 非依存)。
  { id: "shogai", label: "障害請求" },
];

// タブナビ (order-app の BillingSubTabNav と同一クラス)
function SeikyuTabNav({
  active,
  onChange,
}: {
  active: SeikyuTab;
  onChange: (id: SeikyuTab) => void;
}) {
  return (
    <div className="border-b border-gray-200 bg-white px-3 py-2 shrink-0 flex items-center gap-2 print:hidden">
      {SEIKYU_TABS.map((t) => (
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
  const [tab, setTab] = useState<SeikyuTab>("monthly");
  return (
    // layout の main (p-6) を打ち消して order-app と同じ全面白ベースにする。
    // 高さは main の可視領域いっぱい (padding 3rem ぶんを足し戻す)。
    // 印刷時は高さ固定と flex を解除して印刷 view の流し込みを崩さない。
    <div className="-m-6 flex h-[calc(100%+3rem)] flex-col bg-white text-sm print:m-0 print:block print:h-auto">
      <SeikyuTabNav active={tab} onChange={setTab} />
      {tab === "monthly" && <MonthlyInfoContent />}
      {tab === "kaigo" && <KaigoSeikyuContent />}
      {tab === "riyou" && <RiyouSeikyuContent />}
      {tab === "kokuho" && <KokuhoSeikyuContent />}
      {tab === "shogai" && <ShogaiSeikyuContent />}
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
