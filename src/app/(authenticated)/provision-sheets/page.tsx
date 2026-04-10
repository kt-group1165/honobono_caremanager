"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * /provision-sheets は /reports/service-usage にリダイレクトする。
 * 利用票・提供票の入力は帳票画面（第6表）のレイアウトをそのまま流用する方針。
 */
export default function ProvisionSheetsRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/reports/service-usage");
  }, [router]);

  return (
    <div className="flex items-center justify-center py-24 text-sm text-gray-400">
      帳票画面の利用票・提供票に移動しています...
    </div>
  );
}
