"use client";

/**
 * /billing-visit/seikyu — 請求 (1 画面タブ切替)
 *
 * 月次情報 / 介護請求 / 利用請求 / 国保請求 を 1 画面のタブで切替える
 * (参考: order-app の BillingTab)。SeikyuProvider で月 state と集計結果を
 * 全タブ横断で共有し、fetch は 1 回。共通ツールバーの MonthNav を Context の
 * year/month/onMonthChange に接続する。
 */

import { useState } from "react";
import { Calculator } from "lucide-react";
import { MonthNav } from "../_shared/month-nav";
import { SeikyuProvider, useSeikyuContext } from "../_shared/seikyu-context";
import { MonthlyInfoContent } from "../_shared/monthly-info-content";
import { KaigoSeikyuContent } from "../kaigo-seikyu/kaigo-seikyu-content";
import { RiyouSeikyuContent } from "../riyou-seikyu/riyou-seikyu-content";
import { KokuhoSeikyuContent } from "../kokuho-seikyu/kokuho-seikyu-content";

type SeikyuTab = "monthly" | "kaigo" | "riyou" | "kokuho";

const SEIKYU_TABS: { id: SeikyuTab; label: string }[] = [
  { id: "monthly", label: "月次情報" },
  { id: "kaigo", label: "介護請求" },
  { id: "riyou", label: "利用請求" },
  { id: "kokuho", label: "国保請求" },
];

// タブナビ (order-app の BillingSubTabNav 風。選択タブを強調)
function SeikyuTabNav({
  active,
  onChange,
}: {
  active: SeikyuTab;
  onChange: (id: SeikyuTab) => void;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-gray-200 pb-2 print:hidden">
      {SEIKYU_TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={
            "rounded-lg px-3 py-1 text-xs font-medium transition-colors " +
            (active === t.id
              ? "bg-blue-600 text-white"
              : "bg-gray-100 text-gray-500 hover:bg-gray-200")
          }
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// 共通ツールバー (MonthNav)。Context の月 state に接続。
function SeikyuToolbar() {
  const { year, month, onMonthChange } = useSeikyuContext();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
      <h1 className="flex items-center gap-2 text-xl font-bold text-gray-900">
        <Calculator size={20} className="text-blue-600" />
        請求
      </h1>
      <MonthNav year={year} month={month} onChange={onMonthChange} />
    </div>
  );
}

function SeikyuInner() {
  const [tab, setTab] = useState<SeikyuTab>("monthly");
  return (
    <div className="space-y-4">
      <SeikyuToolbar />
      <SeikyuTabNav active={tab} onChange={setTab} />
      {tab === "monthly" && <MonthlyInfoContent />}
      {tab === "kaigo" && <KaigoSeikyuContent />}
      {tab === "riyou" && <RiyouSeikyuContent />}
      {tab === "kokuho" && <KokuhoSeikyuContent />}
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
