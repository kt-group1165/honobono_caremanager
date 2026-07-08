"use client";

/**
 * 障害福祉画面の事業所種別ガード。
 * 障害福祉サービス (居宅介護等) の実績・請求は訪問介護事業所で運用するため、
 * それ以外の office (居宅介護支援 / 訪問入浴 / 訪問看護) では案内を出して本体を出さない。
 * Server Component のページからも children 合成で使える。
 */

import { useBusinessType } from "@/lib/business-type-context";

export function ShogaiOfficeGuard({ children }: { children: React.ReactNode }) {
  const { currentOffice, loading } = useBusinessType();
  if (loading) return null;
  if (currentOffice && currentOffice.service_type !== "訪問介護") {
    return (
      <div className="m-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        この機能は訪問介護事業所専用です。ヘッダーの事業所切替で訪問介護の事業所を選択してください。
      </div>
    );
  }
  return <>{children}</>;
}
