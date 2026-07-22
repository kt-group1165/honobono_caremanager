"use client";

import { useState } from "react";
import { ClipboardList, FileSpreadsheet } from "lucide-react";
import { BenefitsContent } from "./benefits-content";
import { ClaimsContent, type ClaimsContentProps } from "../claims/claims-content";
import type { BenefitManagementRow, UserWithCert } from "./benefits-shared";

type Tab = "benefits" | "claims";

export interface BenefitClaimsTabsProps {
  initialTab: Tab;
  benefitsProps: {
    initialMonth: string;
    initialUsers: UserWithCert[];
    initialRows: BenefitManagementRow[];
  };
  claimsProps: ClaimsContentProps;
}

/**
 * 給付管理 (kaigo_benefit_management) と 居宅介護支援レセプト
 * (kaigo_care_support_claims) を 1 画面 2 タブに統合。
 * 同じ月・同じ利用者集合を扱うため、サイドバーからは「レセプト・給付管理」1 項目で入る。
 */
export function BenefitClaimsTabs({
  initialTab,
  benefitsProps,
  claimsProps,
}: BenefitClaimsTabsProps) {
  const [tab, setTab] = useState<Tab>(initialTab);

  const tabBtn = (key: Tab, label: string, Icon: typeof ClipboardList) => {
    const active = tab === key;
    return (
      <button
        onClick={() => {
          setTab(key);
          // 共有可能な URL にしておく (deep-link / リロード時の初期タブ復元用)
          if (typeof window !== "undefined") {
            const url = new URL(window.location.href);
            url.searchParams.set("tab", key);
            window.history.replaceState(null, "", url.toString());
          }
        }}
        className={
          "flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors " +
          (active
            ? "border-sky-600 text-sky-700"
            : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300")
        }
      >
        <Icon size={15} />
        {label}
      </button>
    );
  };

  return (
    <div>
      <div className="flex items-center gap-1 border-b border-gray-200 px-4">
        {tabBtn("benefits", "給付管理", FileSpreadsheet)}
        {tabBtn("claims", "レセプト", ClipboardList)}
      </div>

      {/* 各タブは自前の月選択・ツールバー・見出しを持つ。状態保持のため両方 mount し
          非表示側は hidden で隠す (タブ往復で再取得しない)。 */}
      <div className={tab === "benefits" ? "" : "hidden"}>
        <BenefitsContent {...benefitsProps} />
      </div>
      <div className={tab === "claims" ? "" : "hidden"}>
        <ClaimsContent {...claimsProps} />
      </div>
    </div>
  );
}
