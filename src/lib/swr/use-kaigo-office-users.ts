"use client";

import useSWR from "swr";
import { createClient } from "@/lib/supabase/client";
import type { KaigoUser } from "@/app/(authenticated)/shift-management/_shared";

// SWR 返り値の参照安定化 (data??[] を毎回新配列にすると無限再レンダの温床)
const EMPTY_USERS: never[] = [];

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
      .order("id").range(fromA, fromA + PAGE - 1);
    if (!assigns || assigns.length === 0) break;
    clientIdsAll.push(...(assigns as { client_id: string }[]).map((a) => a.client_id));
    if (assigns.length < PAGE) break;
    fromA += PAGE;
  }
  const uniqueClientIds = Array.from(new Set(clientIdsAll));

  // 2) clients を chunk 単位で fetch。
  //   ⚠ 2026-09-03 実測: chunk=500 だと .in() が Postgres の実行計画の閾値を超えて
  //     seq scan に落ち、9,097 件のテーブルに対し 1 回 7.5 秒以上かかっていた
  //     (250 件以下なら数十ms、400 件で突然 7 秒超という非線形の崖がある)。
  //     150 件 chunk + 並列 fetch に変更し 8,300ms → 101ms (最大規模事業所 651 名) に短縮。
  const CHUNK = 150;
  const chunks: string[][] = [];
  for (let i = 0; i < uniqueClientIds.length; i += CHUNK) {
    chunks.push(uniqueClientIds.slice(i, i + CHUNK));
  }
  const results = await Promise.all(
    chunks.map((chunk) =>
      supabase
        .from("clients")
        .select("id, name, name_kana:furigana, status")
        .in("id", chunk)
        .eq("status", "active")
        .eq("is_facility", false)
        .is("deleted_at", null),
    ),
  );
  const users: KaigoUser[] = results.flatMap((r) => (r.data ?? []) as KaigoUser[]);
  // chunk 単位の取得は事業所全体の furigana 順を保証しないため、ここで最終ソート
  // (元のクエリの order("furigana", { nullsFirst: false }) と同じ並び: null/空は末尾)
  users.sort((a, b) => {
    const an = a.name_kana, bn = b.name_kana;
    if (!an && !bn) return 0;
    if (!an) return 1;
    if (!bn) return -1;
    return an.localeCompare(bn, "ja");
  });
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
    users: data ?? EMPTY_USERS,
    isLoading,
    error: error ?? null,
    mutate: () => {
      void mutate();
    },
  };
}
