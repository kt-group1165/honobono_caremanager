"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * /services/care-plans は /reports/care-plan-1 にリダイレクトする。
 * 計画書の入力・プレビューは帳票画面（第1表/第2表/第3表）のレイアウトを
 * そのまま流用する方針のため、このページは薄い redirect として維持する。
 */
export default function CarePlansRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/reports/care-plan-1");
  }, [router]);

  return (
    <div className="flex items-center justify-center py-24 text-sm text-gray-400">
      帳票画面の第1表に移動しています...
    </div>
  );
}
