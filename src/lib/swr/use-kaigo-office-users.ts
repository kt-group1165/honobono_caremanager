"use client";

import useSWR from "swr";
import { createClient } from "@/lib/supabase/client";
import type { KaigoUser } from "@/app/(authenticated)/shift-management/_shared";

/**
 * 自事業所 (officeId) に紐づく active client (利用者) 一覧を取得する hook (SWR ベース)。
 *
 * client_office_assignments junction 経由で絞り込み。PostgREST 1000 行制限対策で page-loop。
 *
 * 撤去の容易さ:
 *   - SWR は本 lib/swr/ ディレクトリの hook 内のみで使用。
 *
 * Cache key: `kaigo-office-users:{officeId}` (officeId 未指定時は fetch しない)
 */

const SWR_OPTIONS = {
  revalidateOnFocus: false,
  revalidateOnReconnect: true,
  keepPreviousData: true,
} as const;

const PAGE = 1000;

async function fetchOfficeUsers(officeId: string): Promise<KaigoUser[]> {
  const supabase = createClient();
  // 1) client_office_assignments で officeId に紐づく client_id 集合を取得 (page-loop)
  const clientIdsAll: string[] = [];
  let fromA = 0;
  while (true) {
    const { data: assigns } = await supabase
      .from("client_office_assignments")
      .select("client_id")
      .eq("office_id", officeId)
      .is("end_date", null)
      .range(fromA, fromA + PAGE - 1);
    if (!assigns || assigns.length === 0) break;
    clientIdsAll.push(...(assigns as { client_id: string }[]).map((a) => a.client_id));
    if (assigns.length < PAGE) break;
    fromA += PAGE;
  }
  const uniqueClientIds = Array.from(new Set(clientIdsAll));

  // 2) clients を chunk 単位で fetch (.in() の URL 長制限を回避)
  const users: KaigoUser[] = [];
  if (uniqueClientIds.length > 0) {
    let fromU = 0;
    while (true) {
      const chunk = uniqueClientIds.slice(fromU, fromU + 500);
      if (chunk.length === 0) break;
      const { data } = await supabase
        .from("clients")
        .select("id, name, name_kana:furigana, status")
        .in("id", chunk)
        .eq("status", "active")
        .eq("is_facility", false)
        .order("furigana", { nullsFirst: false });
      if (data && data.length > 0) users.push(...(data as KaigoUser[]));
      fromU += 500;
    }
  }
  return users;
}

export function useKaigoOfficeUsers(
  officeId: string | null,
  fallbackData?: KaigoUser[],
) {
  const key = officeId ? `kaigo-office-users:${officeId}` : null;
  const { data, error, isLoading, mutate } = useSWR<KaigoUser[]>(
    key,
    () => fetchOfficeUsers(officeId as string),
    { ...SWR_OPTIONS, fallbackData },
  );
  return {
    users: data ?? [],
    isLoading,
    error: error ?? null,
    mutate: () => {
      void mutate();
    },
  };
}
