"use client";

/**
 * /billing/seikyu — 請求 (居宅介護支援・1 画面タブ切替)
 *
 * 月次情報 / 介護請求 / 国保請求 / 入金管理 を 1 画面のタブで切替える。
 * 見た目は訪問介護版 /billing-visit/seikyu と同一 (ピル型サブタブ + 各タブ内に
 * カナ索引サイドバー + グレーツールバー + 格子テーブル)。
 * KyotakuSeikyuProvider で月 state / レセプト集計 / カナフィルタを全タブ横断で共有し、
 * fetch は 1 回。
 *
 * 居宅は 10 割給付で利用者請求が無いため「利用請求」タブは無し。
 * 代わりに国保連入金消込の「入金管理」タブを置く。
 */

import { useState } from "react";
import {
  KyotakuSeikyuProvider,
  useKyotakuSeikyuContext,
  SeikyuMonthNav,
} from "./_seikyu-context";
import { KyotakuKojinSetteiContent } from "./_kojin-settei";
import { KyotakuMonthlyInfoContent } from "./_monthly-info";
import { KyotakuKaigoSeikyuContent } from "./_kaigo-seikyu";
import { KyotakuKokuhoSeikyuContent } from "./_kokuho-seikyu";
import { NyukinContent } from "./_nyukin-content";

type SeikyuTab = "kojin" | "monthly" | "kaigo" | "kokuho" | "nyukin";

const SEIKYU_TABS: { id: SeikyuTab; label: string }[] = [
  { id: "kojin", label: "請求個人設定" },
  { id: "monthly", label: "月次情報" },
  { id: "kaigo", label: "介護請求" },
  { id: "kokuho", label: "国保請求" },
  { id: "nyukin", label: "入金管理" },
];

// タブナビ (billing-visit 版 = order-app の BillingSubTabNav と同一クラス)
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

// 入金管理タブ: 月ナビ付きツールバー + NyukinContent (実装は _nyukin-content.tsx)
function NyukinTab() {
  const { officeId, tenantId, monthKey } = useKyotakuSeikyuContext();
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center gap-2">
        <SeikyuMonthNav />
        <span className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 font-medium">入金管理</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <NyukinContent officeId={officeId} tenantId={tenantId} month={monthKey} />
      </div>
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
      {tab === "kojin" && <KyotakuKojinSetteiContent />}
      {tab === "monthly" && <KyotakuMonthlyInfoContent />}
      {tab === "kaigo" && <KyotakuKaigoSeikyuContent />}
      {tab === "kokuho" && <KyotakuKokuhoSeikyuContent />}
      {tab === "nyukin" && <NyukinTab />}
    </div>
  );
}

export function KyotakuSeikyuContent() {
  return (
    <KyotakuSeikyuProvider>
      <SeikyuInner />
    </KyotakuSeikyuProvider>
  );
}
